/** 通报处理状态：pending 挂起（环号本站没有 / 接收失败，等人工处理）/ matched 已匹配本站台账 */
export type NoticeStatus = 'pending' | 'matched';

/**
 * 环志中心回收通报。
 *
 * 通报只带中心侧字段：环号、回收地、回收日期（这三项以中心为准）；
 * 鸟种 / 量度 / 鸟点以本站台账为准，匹配后通过 matchedRingId 关联 RingRecord。
 * 两边各记各的，互不覆盖。
 */
export interface RecoveryNotice {
  id: string;
  /** 金属环号（中心通报） */
  ringNo: string;
  /** 回收地（中心通报，权威） */
  recoverySite: string;
  /** 回收日期 ISO（中心通报，权威） */
  recoveryDate: string;
  /** 处理状态：pending 挂起 / matched 已匹配本站台账 */
  status: NoticeStatus;
  /** 匹配到的本站环志记录 id（status=matched 时有值） */
  matchedRingId?: string;
  /** 挂起 / 失败原因（status=pending 时有值），如「本站台账无此环号」 */
  failReason?: string;
  /** 接收时间 ISO */
  receivedAt: string;
  /** 最近一次重试时间 ISO */
  retriedAt?: string;
  /** 已重试次数 */
  retryCount: number;
}

/** 通报状态配色（ElTag type） */
export const NOTICE_STATUS_COLOR: Record<NoticeStatus, 'warning' | 'success'> = {
  pending: 'warning',
  matched: 'success',
};

/** 通报状态文案 */
export const NOTICE_STATUS_LABEL: Record<NoticeStatus, string> = {
  pending: '挂起',
  matched: '已匹配',
};
