import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { toPlain } from '../utils/plain';
import { matchNotice, parseNotices } from '../utils/recovery';
import type { RecoveryNotice } from '../types/recovery-notice';
import { useRingStore } from './ringStore';

interface NoticeState {
  notices: RecoveryNotice[];
  hydrated: boolean;
}

/**
 * 环志中心回收通报。
 * 通报（中心侧：环号 / 回收地 / 回收日期）与本站台账（鸟种 / 量度 / 鸟点）各记各的，
 * 匹配后通过 matchedRingId 关联，互不覆盖。
 */
export const useNoticeStore = defineStore('notice', {
  state: (): NoticeState => ({ notices: [], hydrated: false }),

  getters: {
    pendingCount(state): number {
      return state.notices.filter((notice) => notice.status === 'pending').length;
    },
    matchedCount(state): number {
      return state.notices.filter((notice) => notice.status === 'matched').length;
    },
    pendingNotices(state): RecoveryNotice[] {
      return state.notices.filter((notice) => notice.status === 'pending');
    },
    matchedNotices(state): RecoveryNotice[] {
      return state.notices.filter((notice) => notice.status === 'matched');
    },
  },

  actions: {
    async hydrate() {
      this.notices = await db.notices.orderBy('receivedAt').reverse().toArray();
      this.hydrated = true;
    },

    /**
     * 批量导入通报文本。
     * 逐条独立处理：已写进本站的部分保留，不因某一条失败而回滚已成功的（按中心那边重试即可）。
     * 环号本站没有 → 通报挂起，不凭空生成环志记录。
     */
    async importText(text: string): Promise<{ matched: number; pending: number }> {
      const incoming = parseNotices(text);
      const ringStore = useRingStore();
      let matched = 0;
      let pending = 0;
      for (const raw of incoming) {
        const { notice, ring } = matchNotice(raw, ringStore.rings);
        await db.notices.put(toPlain(notice));
        if (ring) {
          await ringStore.markRecovered(ring.id);
          matched += 1;
        } else {
          pending += 1;
        }
      }
      this.notices = await db.notices.orderBy('receivedAt').reverse().toArray();
      return { matched, pending };
    },

    /** 新增单条通报（页面表单用），处理规则与批量导入一致 */
    async addNotice(input: { ringNo: string; recoverySite: string; recoveryDate: string }): Promise<'matched' | 'pending'> {
      const now = new Date().toISOString();
      const raw: RecoveryNotice = {
        id: `notice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        ringNo: input.ringNo.trim(),
        recoverySite: input.recoverySite.trim(),
        recoveryDate: input.recoveryDate ? new Date(`${input.recoveryDate}T08:00:00`).toISOString() : now,
        status: 'pending',
        receivedAt: now,
        retryCount: 0,
      };
      const ringStore = useRingStore();
      const { notice, ring } = matchNotice(raw, ringStore.rings);
      await db.notices.put(toPlain(notice));
      if (ring) await ringStore.markRecovered(ring.id);
      this.notices = await db.notices.orderBy('receivedAt').reverse().toArray();
      return notice.status;
    },

    /**
     * 重试单条通报：按中心通报重新匹配（回收地 / 回收日期仍认通报）。
     * 已写入本站的部分保留，只推进未匹配的通报；重试次数 +1。
     */
    async retryNotice(id: string): Promise<'matched' | 'pending'> {
      const current = this.notices.find((notice) => notice.id === id);
      if (!current) return 'pending';
      const ringStore = useRingStore();
      const candidate: RecoveryNotice = {
        ...current,
        retryCount: current.retryCount + 1,
        retriedAt: new Date().toISOString(),
      };
      const { notice, ring } = matchNotice(candidate, ringStore.rings);
      await db.notices.put(toPlain(notice));
      if (ring) await ringStore.markRecovered(ring.id);
      this.notices = this.notices.map((item) => (item.id === id ? notice : item));
      return notice.status;
    },

    /** 重试全部挂起通报，返回新匹配 / 仍挂起的数量 */
    async retryAll(): Promise<{ matched: number; pending: number }> {
      let matched = 0;
      let pending = 0;
      for (const notice of [...this.pendingNotices]) {
        const result = await this.retryNotice(notice.id);
        if (result === 'matched') matched += 1;
        else pending += 1;
      }
      return { matched, pending };
    },

    /**
     * 人工指定匹配：用于自动匹配未命中、但实际是同一只的情况。
     * 把通报挂到指定环志记录，鸟种 / 量度 / 鸟点仍以该环志记录（本站台账）为准。
     */
    async manualMatch(noticeId: string, ringId: string) {
      const notice = this.notices.find((item) => item.id === noticeId);
      const ring = useRingStore().rings.find((item) => item.id === ringId);
      if (!notice || !ring) return;
      const next: RecoveryNotice = {
        ...notice,
        status: 'matched',
        matchedRingId: ring.id,
        failReason: undefined,
        retryCount: notice.retryCount + 1,
        retriedAt: new Date().toISOString(),
      };
      await db.notices.put(toPlain(next));
      await useRingStore().markRecovered(ring.id);
      this.notices = this.notices.map((item) => (item.id === noticeId ? next : item));
    },

    async removeNotice(id: string) {
      await db.notices.delete(id);
      this.notices = this.notices.filter((notice) => notice.id !== id);
    },
  },
});
