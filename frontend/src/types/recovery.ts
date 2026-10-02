/** 回收通报处理状态（本站归属） */
export type RecoveryStatus = '待处理' | '已匹配';

/**
 * 环志中心回收通报（一条通报 = 一个被中心回收的环号）。
 *
 * 字段按归属拆分，两边对不上时各认各的：
 * - 中心归属（只以中心通报为准，重新接入时覆盖）：centerKey / batchNo / ringNo / recoveryPlace / recoveryDate
 * - 本站归属（不由通报写入，只通过 ringId 关联本站环志台账）：鸟种、量度、鸟点
 * - 本站台账查无此环号时 status = 待处理，挂起等人工处理，绝不凭空生成环志记录
 */
export interface RecoveryReport {
  /** 本站记录 id */
  id: string;
  /** 中心侧唯一键（批次号#环号，归一小写），重复接入按此键幂等更新 */
  centerKey: string;
  /** 通报批次号（中心） */
  batchNo: string;
  /** 金属环号（中心） */
  ringNo: string;
  /** 回收地（中心） */
  recoveryPlace: string;
  /** 回收日期 YYYY-MM-DD（中心） */
  recoveryDate: string;
  /** 处理状态：待处理 = 环号在本站台账无对应环志记录 */
  status: RecoveryStatus;
  /** 匹配到的本站环志记录 id；鸟种 / 量度 / 鸟点的唯一来源，待处理时为空 */
  ringId?: string;
  /** 匹配方式：自动比对 / 人工 */
  matchedBy?: string;
  /** 匹配时间 ISO */
  matchedAt?: string;
  /** 首次接入时间 ISO */
  importedAt: string;
  /** 最近一次按中心通报刷新时间 ISO */
  updatedAt: string;
  /** 本站备注（人工处理用，中心不覆盖） */
  remark?: string;
}

/** 中心通报单条原始项：只有环号、回收地、回收日期 */
export interface CenterRecoveryItem {
  ringNo: string;
  recoveryPlace: string;
  /** YYYY-MM-DD 或 ISO 日期 */
  recoveryDate: string;
}

/** 中心通报批次报文 */
export interface CenterRecoveryBatch {
  /** 批次号；缺省时按接入日期生成 */
  batchNo: string;
  /** 中心发布日期（可选） */
  publishedAt?: string;
  items: CenterRecoveryItem[];
}

export const RECOVERY_STATUSES: RecoveryStatus[] = ['待处理', '已匹配'];

export const RECOVERY_STATUS_TAG: Record<RecoveryStatus, 'warning' | 'success'> = {
  待处理: 'warning',
  已匹配: 'success',
};
