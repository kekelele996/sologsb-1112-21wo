import type { CenterRecoveryBatch, CenterRecoveryItem } from '../types/recovery';

/**
 * 环志中心通报接入。纯前端、无后端：
 * - 中心无开放接口时，由站点把中心下发的通报 JSON 粘进来 / 选文件接入（parseBulletin）；
 * - 中心提供拉取地址时（localStorage「center.endpoint」），用 fetchBulletin 按中心口径重试。
 *
 * 两边对不上时字段归属分开：本模块只产出中心的「环号 / 回收地 / 回收日期」，
 * 鸟种、量度、鸟点一律以本站台账为准。
 */

/** 中心拉取地址的本地配置键（可选；纯静态托管时由站点自行填写中心提供的 JSON 地址） */
export const CENTER_ENDPOINT_KEY = 'gbbirdring.centerEndpoint';

/** 行级解析错误：不阻断整批，由调用方逐行提示并可按中心原文修正后重试 */
export interface RecoveryRowError {
  index: number;
  raw: unknown;
  message: string;
}

export interface ParsedBulletin {
  batchNo: string;
  items: ParsedRecoveryRow[];
  errors: RecoveryRowError[];
}

export interface ParsedRecoveryRow {
  ringNo: string;
  recoveryPlace: string;
  recoveryDate: string;
}

/** 回收日期归一为 YYYY-MM-DD，认中心日期，解析不了就报错（不猜、不补当天） */
export function normalizeRecoveryDate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('回收日期为空');
  }
  const raw = value.trim();
  const date = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`回收日期「${raw}」无法识别`);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 环号归一：去空白，保留原始大小写比较（比较时两边都转小写） */
export function normalizeRingNo(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('环号不是文本');
  }
  const ringNo = value.trim();
  if (!ringNo) {
    throw new Error('环号为空');
  }
  return ringNo;
}

/** 解析中心通报批次 JSON；逐行校验，坏行进 errors，好行进 items */
export function parseBulletin(text: string): ParsedBulletin {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('通报不是合法 JSON');
  }

  const batch = asBatch(data);
  const items: ParsedRecoveryRow[] = [];
  const errors: RecoveryRowError[] = [];
  batch.items.forEach((raw, index) => {
    try {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error('通报行不是对象');
      }
      const row = raw as unknown as Record<string, unknown>;
      const recoveryPlace = typeof row.recoveryPlace === 'string' ? row.recoveryPlace.trim() : '';
      if (!recoveryPlace) {
        throw new Error('回收地为空');
      }
      items.push({
        ringNo: normalizeRingNo(row.ringNo),
        recoveryPlace,
        recoveryDate: normalizeRecoveryDate(row.recoveryDate),
      });
    } catch (error) {
      errors.push({ index: index + 1, raw, message: (error as Error).message });
    }
  });

  if (items.length === 0 && errors.length === 0) {
    throw new Error('通报里没有任何回收条目');
  }

  return { batchNo: batch.batchNo, items, errors };
}

function asBatch(data: unknown): CenterRecoveryBatch {
  if (typeof data !== 'object' || data === null) {
    throw new Error('通报报文不是对象');
  }
  const obj = data as Record<string, unknown>;
  let rawItems: unknown[];
  if (Array.isArray(obj.items)) {
    rawItems = obj.items;
  } else if (Array.isArray(data)) {
    rawItems = data as unknown[];
  } else {
    throw new Error('通报缺少 items 数组');
  }
  const batchNo = typeof obj.batchNo === 'string' && obj.batchNo.trim() ? obj.batchNo.trim() : `CENTRAL-${new Date().toISOString().slice(0, 10)}`;
  return { batchNo, publishedAt: typeof obj.publishedAt === 'string' ? obj.publishedAt : undefined, items: rawItems as CenterRecoveryItem[] };
}

/** 组装中心唯一键：同批次同环号的通报重复接入时幂等覆盖（环号归一小写，避免大小写差异产生重复） */
export function buildCenterKey(batchNo: string, ringNo: string): string {
  return `${batchNo}#${ringNo.replace(/\s+/g, '').toLowerCase()}`;
}

export interface FetchResult {
  batch: CenterRecoveryBatch;
  endpoint: string;
}

/**
 * 从中心地址拉取通报。失败时抛出错误，由调用方按中心口径重试；
 * 本函数不写任何本地数据——已经写进本站的部分在重试时原样保留（见 recoveryStore.importRows）。
 */
export async function fetchBulletin(endpoint: string, init?: RequestInit, timeoutMs = 15_000): Promise<FetchResult> {
  const url = endpoint.trim();
  if (!url) {
    throw new Error('未配置中心通报地址');
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) {
      throw new Error(`中心返回 HTTP ${res.status} ${res.statusText}`);
    }
    const data: unknown = await res.json();
    const batch = asBatch(data);
    if (batch.items.length === 0) {
      throw new Error('中心通报为空批次');
    }
    return { batch, endpoint: url };
  } finally {
    window.clearTimeout(timer);
  }
}

/** 中心报文转解析行（供拉取成功后复用同一套行级校验） */
export function batchToParsed(batch: CenterRecoveryBatch): ParsedBulletin {
  return parseBulletin(JSON.stringify(batch));
}

/**
 * 中心通报示例（演示 / 下载模板用）。
 * 故意混入一个本站没有的环号，演示「挂起待人工处理」；
 * 不写入任何本站记录，本站台账的鸟种 / 量度 / 鸟点仍认本站。
 */
const dateDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export const SAMPLE_BULLETIN: CenterRecoveryBatch = {
  batchNo: 'HB-2024-R07',
  publishedAt: dateDaysAgo(1),
  items: [
    { ringNo: 'A-10231', recoveryPlace: '辽宁盘锦鸳鸯沟', recoveryDate: dateDaysAgo(3) },
    { ringNo: 'B-20513', recoveryPlace: '河北秦皇岛北戴河', recoveryDate: dateDaysAgo(5) },
    { ringNo: 'A-10243', recoveryPlace: '山东烟台夹河', recoveryDate: dateDaysAgo(9) },
    { ringNo: 'Z-99999', recoveryPlace: '上海崇明东滩', recoveryDate: dateDaysAgo(1) },
  ],
};
