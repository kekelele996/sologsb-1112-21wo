import { defineStore } from 'pinia';
import { db, getMeta, setMeta } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { CENTER_ENDPOINT_KEY, buildCenterKey, type ParsedRecoveryRow } from '../utils/recoveryCenter';
import type { RecoveryReport } from '../types/recovery';
import { useRingStore } from './ringStore';

/** 一次接入结果：逐行落库，失败的行/整批失败不回滚已写入部分 */
export interface ImportResult {
  batchNo: string;
  /** 新写入条数 */
  inserted: number;
  /** 按中心口径刷新条数（中心字段覆盖，本站匹配关系保留） */
  updated: number;
  /** 匹配后挂起（本站无此环号）的条数 */
  pending: number;
  /** 自动匹配到本站环志记录的条数 */
  matched: number;
  /** 逐行落库失败明细（理论上仅 IndexedDB 异常） */
  failed: Array<{ ringNo: string; message: string }>;
}

interface RecoveryState {
  reports: RecoveryReport[];
  hydrated: boolean;
  /** 最近一次从中心拉取的报错；成功后清空（按中心口径重试的入口依据） */
  lastFetchError: string;
  /** 最近一次拉取时间 ISO */
  lastFetchedAt: string;
}

/** 环志中心回收通报：接入、匹配与挂起处理 */
export const useRecoveryStore = defineStore('recovery', {
  state: (): RecoveryState => ({ reports: [], hydrated: false, lastFetchError: '', lastFetchedAt: '' }),

  actions: {
    async hydrate() {
      this.reports = await db.recoveries.orderBy('recoveryDate').reverse().toArray();
      this.lastFetchError = (await getMeta('recovery.lastFetchError')) ?? '';
      this.lastFetchedAt = (await getMeta('recovery.lastFetchedAt')) ?? '';
      this.hydrated = true;
    },

    /** 本站台账中与通报环号对应的环志记录：同环号取最早的环志（首次环志个体） */
    resolveRing(ringNo: string) {
      const ringStore = useRingStore();
      return ringStore.historyOf(ringNo)[0];
    },

    /**
     * 接入一批已解析的中心通报行（逐行落库）。
     * - 中心字段（环号 / 回收地 / 回收日期 / 批次）幂等覆盖；
     * - 本站字段绝不写入，匹配关系 ringId 与本站备注在刷新时保留；
     * - 本站查无环号 → 待处理挂起，绝不凭空生成环志记录；
     * - 某一行失败只记入 failed，已写入本站的行保留，可直接按中心报文重试。
     */
    async importRows(batchNo: string, rows: ParsedRecoveryRow[]): Promise<ImportResult> {
      const result: ImportResult = { batchNo, inserted: 0, updated: 0, pending: 0, matched: 0, failed: [] };
      const now = new Date().toISOString();

      for (const row of rows) {
        const centerKey = buildCenterKey(batchNo, row.ringNo);
        try {
          const existing = await db.recoveries.where('centerKey').equals(centerKey).first();
          const localRing = this.resolveRing(row.ringNo);
          if (existing) {
            // 中心口径刷新：只覆盖中心归属字段；ringId / 本站备注 / 匹配方式保留
            const next: RecoveryReport = {
              ...existing,
              batchNo,
              ringNo: row.ringNo,
              recoveryPlace: row.recoveryPlace,
              recoveryDate: row.recoveryDate,
              updatedAt: now,
            };
            // 本站后来补登了环号时，挂起记录可转为自动匹配；已人工匹配的不动
            if (next.status === '待处理' && localRing) {
              next.status = '已匹配';
              next.ringId = localRing.id;
              next.matchedBy = '自动比对';
              next.matchedAt = now;
            }
            await db.recoveries.put(toPlain(next));
            this.upsertState(next);
            result.updated += 1;
            if (next.status === '待处理') result.pending += 1;
            else result.matched += 1;
          } else {
            const report: RecoveryReport = {
              id: uid('recovery'),
              centerKey,
              batchNo,
              ringNo: row.ringNo,
              recoveryPlace: row.recoveryPlace,
              recoveryDate: row.recoveryDate,
              status: localRing ? '已匹配' : '待处理',
              ringId: localRing?.id,
              matchedBy: localRing ? '自动比对' : undefined,
              matchedAt: localRing ? now : undefined,
              importedAt: now,
              updatedAt: now,
            };
            await db.recoveries.put(toPlain(report));
            this.upsertState(report);
            result.inserted += 1;
            if (report.status === '待处理') result.pending += 1;
            else result.matched += 1;
          }
        } catch (error) {
          result.failed.push({ ringNo: row.ringNo, message: (error as Error).message });
        }
      }
      return result;
    },

    /** 对全部挂起记录重新按本站台账比对（本站补登环志记录后使用） */
    async rematchPending(): Promise<number> {
      const now = new Date().toISOString();
      let resolved = 0;
      for (const report of this.reports.filter((item) => item.status === '待处理')) {
        const localRing = this.resolveRing(report.ringNo);
        if (!localRing) continue;
        const next: RecoveryReport = {
          ...report,
          status: '已匹配',
          ringId: localRing.id,
          matchedBy: '自动比对',
          matchedAt: now,
        };
        await db.recoveries.put(toPlain(next));
        this.upsertState(next);
        resolved += 1;
      }
      return resolved;
    },

    /** 人工把挂起通报指定到本站某条环志记录（环号不一致需页面先确认） */
    async assignRing(id: string, ringId: string) {
      const report = this.reports.find((item) => item.id === id);
      if (!report) return;
      const now = new Date().toISOString();
      const next: RecoveryReport = { ...report, status: '已匹配', ringId, matchedBy: '人工', matchedAt: now };
      await db.recoveries.put(toPlain(next));
      this.upsertState(next);
    },

    /** 解除匹配，退回挂起（本站台账删除环号或人工误配时） */
    async unassign(id: string) {
      const report = this.reports.find((item) => item.id === id);
      if (!report) return;
      const { ringId: _ringId, matchedBy: _matchedBy, matchedAt: _matchedAt, ...rest } = report;
      const next: RecoveryReport = { ...rest, status: '待处理' };
      await db.recoveries.put(toPlain(next));
      this.upsertState(next);
    },

    /** 本站备注（人工处理用，中心刷新不覆盖） */
    async setRemark(id: string, remark: string) {
      const report = this.reports.find((item) => item.id === id);
      if (!report) return;
      const next: RecoveryReport = { ...report, remark: remark.trim() || undefined };
      await db.recoveries.put(toPlain(next));
      this.upsertState(next);
    },

    /** 删除一条本站侧挂起/通报记录（中心报文仍在，重新接入会原样回来） */
    async remove(id: string) {
      await db.recoveries.delete(id);
      this.reports = this.reports.filter((report) => report.id !== id);
    },

    /** 记录中心拉取错误（本函数不触碰任何通报行，已写入部分原样保留） */
    async markFetchError(message: string) {
      this.lastFetchError = message;
      await setMeta('recovery.lastFetchError', message);
    },

    async clearFetchError() {
      this.lastFetchError = '';
      this.lastFetchedAt = new Date().toISOString();
      await setMeta('recovery.lastFetchError', '');
      await setMeta('recovery.lastFetchedAt', this.lastFetchedAt);
    },

    upsertState(report: RecoveryReport) {
      const idx = this.reports.findIndex((item) => item.id === report.id);
      if (idx >= 0) {
        this.reports = [...this.reports.slice(0, idx), report, ...this.reports.slice(idx + 1)];
      } else {
        this.reports = [report, ...this.reports];
      }
    },
  },
});

/** 中心通报拉取地址（可选，本地可配；纯前端无后端时走粘贴 / 文件接入） */
export function getCenterEndpoint(): string {
  return window.localStorage.getItem(CENTER_ENDPOINT_KEY) ?? '';
}

export function setCenterEndpoint(endpoint: string): void {
  const value = endpoint.trim();
  if (value) {
    window.localStorage.setItem(CENTER_ENDPOINT_KEY, value);
  } else {
    window.localStorage.removeItem(CENTER_ENDPOINT_KEY);
  }
}
