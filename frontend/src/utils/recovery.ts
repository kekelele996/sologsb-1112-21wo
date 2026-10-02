import type { RecoveryNotice } from '../types/recovery-notice';
import type { Morphometrics } from '../types/morphometrics';
import type { RingRecord } from '../types/ring-record';
import { uid } from './id';

/** 日期型 token（YYYY-MM-DD），用于空格分隔文本里识别回收日期 */
const DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把单条通报文本解析为 RecoveryNotice。
 * 支持逗号 / Tab 分隔（环号,回收地,回收日期），也支持空格分隔（回收日期取 YYYY-MM-DD token）。
 */
function parseOne(line: string, receivedAt: string): RecoveryNotice {
  let ringNo = '';
  let recoverySite = '';
  let recoveryDate = '';

  const commaParts = line
    .split(/[,\t]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (commaParts.length >= 3) {
    [ringNo, recoverySite, recoveryDate] = commaParts;
  } else {
    const tokens = line.split(/\s+/).filter(Boolean);
    const dateIdx = tokens.findIndex((token) => DATE_TOKEN.test(token));
    if (dateIdx >= 0) {
      recoveryDate = tokens[dateIdx];
      ringNo = tokens[0] ?? '';
      recoverySite = tokens.slice(1, dateIdx).join('') || tokens.slice(dateIdx + 1).join('');
    } else {
      ringNo = tokens[0] ?? '';
      recoverySite = tokens.slice(1).join('');
    }
  }

  return {
    id: uid('notice'),
    ringNo: ringNo.trim(),
    recoverySite: recoverySite.trim(),
    recoveryDate: normalizeDate(recoveryDate),
    status: 'pending',
    receivedAt,
    retryCount: 0,
  };
}

function normalizeDate(value: string): string {
  const text = value.trim();
  if (!text) return new Date().toISOString();
  if (DATE_TOKEN.test(text)) return new Date(`${text}T08:00:00`).toISOString();
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * 解析批量粘贴的回收通报文本。每行一条，空行与 # 开头的注释行会被忽略。
 */
export function parseNotices(text: string, now: Date = new Date()): RecoveryNotice[] {
  const receivedAt = now.toISOString();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => parseOne(line, receivedAt));
}

/** 在本站台账中按环号查找环志记录（大小写 / 空格不敏感）；取最早一条作为环志底档 */
export function findRingByRingNo(rings: RingRecord[], ringNo: string): RingRecord | undefined {
  const key = ringNo.trim().toLowerCase();
  if (!key) return undefined;
  return rings
    .filter((record) => record.ringNo.trim().toLowerCase() === key)
    .sort((a, b) => a.ringDate.localeCompare(b.ringDate))[0];
}

export interface NoticeMatch {
  notice: RecoveryNotice;
  /** 匹配到的本站环志记录；未匹配时为 undefined（通报挂起，不凭空生成记录） */
  ring?: RingRecord;
}

/**
 * 按归属匹配两边数据：
 * - 回收地 / 回收日期认中心通报（写回 notice）；
 * - 鸟种 / 量度 / 鸟点认本站台账（关联 ring）。
 * 环号本站没有 → 通报挂起（pending），不生成任何环志记录。
 */
export function matchNotice(notice: RecoveryNotice, rings: RingRecord[]): NoticeMatch {
  const ring = findRingByRingNo(rings, notice.ringNo);
  if (!ring) {
    return {
      notice: {
        ...notice,
        status: 'pending',
        matchedRingId: undefined,
        failReason: '本站台账无此环号，待人工处理',
      },
    };
  }
  return {
    notice: {
      ...notice,
      status: 'matched',
      matchedRingId: ring.id,
      failReason: undefined,
    },
    ring,
  };
}

/** 把通报与本站台账拼成一条可展示的合并视图（各取各的字段） */
export interface RecoveryCombined {
  notice: RecoveryNotice;
  ring?: RingRecord;
  /** 鸟种（本站台账） */
  speciesCn: string;
  /** 学名（本站台账） */
  speciesSci: string;
  /** 鸟点名（本站台账） */
  siteName: string;
  /** 最近一次量度（本站台账） */
  morph?: Morphometrics;
}

export function combineRecovery(
  notice: RecoveryNotice,
  rings: RingRecord[],
  morphs: Morphometrics[],
  siteNameOf: (siteId: string) => string,
): RecoveryCombined {
  const ring = notice.matchedRingId ? rings.find((item) => item.id === notice.matchedRingId) : undefined;
  const morph = ring
    ? morphs
        .filter((item) => item.ringId === ring.id)
        .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]
    : undefined;
  return {
    notice,
    ring,
    speciesCn: ring?.speciesCn ?? '—',
    speciesSci: ring?.speciesSci ?? '',
    siteName: ring ? siteNameOf(ring.siteId) : '—',
    morph,
  };
}
