<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useNoticeStore } from '../stores/noticeStore';
import { useRingStore } from '../stores/ringStore';
import { useSiteStore } from '../stores/siteStore';
import { useMeasureStore } from '../stores/measureStore';
import { NOTICE_STATUS_COLOR, NOTICE_STATUS_LABEL, type NoticeStatus, type RecoveryNotice } from '../types/recovery-notice';
import type { RingRecord } from '../types/ring-record';
import { formatDate } from '../utils/format';
import { combineRecovery, type RecoveryCombined } from '../utils/recovery';
import { noticeBreakdown } from '../utils/stats';

const route = useRoute();
const noticeStore = useNoticeStore();
const ringStore = useRingStore();
const siteStore = useSiteStore();
const measureStore = useMeasureStore();

const importText = ref('');
const importing = ref(false);

const breakdown = computed(() => noticeBreakdown(noticeStore.notices));

const combinedRows = computed<RecoveryCombined[]>(() =>
  noticeStore.notices.map((notice) =>
    combineRecovery(notice, ringStore.rings, measureStore.morphs, siteStore.siteName),
  ),
);

/** FilterBar 写入 route.query，这里读取并把中文状态映射回英文 */
const kwParam = computed(() => (typeof route.query.kw === 'string' ? route.query.kw.trim().toLowerCase() : ''));
const statusParam = computed<'' | NoticeStatus>(() => {
  const v = route.query.status;
  if (v === '挂起') return 'pending';
  if (v === '已匹配') return 'matched';
  return '';
});

const visibleRows = computed(() => {
  const kw = kwParam.value;
  return combinedRows.value.filter((row) => {
    if (statusParam.value && row.notice.status !== statusParam.value) return false;
    if (kw) {
      const haystack = `${row.notice.ringNo} ${row.notice.recoverySite} ${row.speciesCn} ${row.siteName}`.toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });
});

async function doImport() {
  const text = importText.value.trim();
  if (!text) {
    ElMessage.warning('请先粘贴回收通报文本');
    return;
  }
  importing.value = true;
  try {
    const result = await noticeStore.importText(text);
    ElMessage.success(`导入完成：已匹配 ${result.matched} 条，挂起 ${result.pending} 条`);
    importText.value = '';
  } catch (error) {
    ElMessage.error(`导入失败：${(error as Error).message}`);
  } finally {
    importing.value = false;
  }
}

async function retry(row: RecoveryCombined) {
  const result = await noticeStore.retryNotice(row.notice.id);
  if (result === 'matched') ElMessage.success(`环号 ${row.notice.ringNo} 已匹配本站台账`);
  else ElMessage.warning(`环号 ${row.notice.ringNo} 仍未匹配，继续挂起等人工处理`);
}

async function retryAll() {
  if (noticeStore.pendingCount === 0) {
    ElMessage.info('没有需要重试的挂起通报');
    return;
  }
  const result = await noticeStore.retryAll();
  ElMessage.success(`重试完成：新匹配 ${result.matched} 条，仍挂起 ${result.pending} 条`);
}

async function remove(row: RecoveryCombined) {
  await noticeStore.removeNotice(row.notice.id);
  ElMessage.success('已删除通报');
}

// ---- 单条新增 ----
const addVisible = ref(false);
const addForm = ref({ ringNo: '', recoverySite: '', recoveryDate: '' });

async function submitAdd() {
  if (!addForm.value.ringNo.trim()) {
    ElMessage.warning('请输入环号');
    return;
  }
  const result = await noticeStore.addNotice(addForm.value);
  if (result === 'matched') ElMessage.success(`环号 ${addForm.value.ringNo} 已匹配本站台账`);
  else ElMessage.warning(`环号 ${addForm.value.ringNo} 本站没有，已挂起等人工处理`);
  addVisible.value = false;
  addForm.value = { ringNo: '', recoverySite: '', recoveryDate: '' };
}

// ---- 人工匹配 ----
const matchVisible = ref(false);
const matchingNotice = ref<RecoveryNotice | undefined>(undefined);
const matchKeyword = ref('');
const selectedRingId = ref('');

const matchOptions = computed(() => {
  const kw = matchKeyword.value.trim().toLowerCase();
  return ringStore.rings
    .filter((record) => {
      if (!kw) return true;
      return `${record.ringNo} ${record.speciesCn} ${record.speciesSci}`.toLowerCase().includes(kw);
    })
    .slice(0, 50);
});

function openManualMatch(row: RecoveryCombined) {
  matchingNotice.value = row.notice;
  matchKeyword.value = row.notice.ringNo;
  selectedRingId.value = '';
  matchVisible.value = true;
}

async function confirmMatch() {
  if (!matchingNotice.value || !selectedRingId.value) {
    ElMessage.warning('请选择要匹配的环志记录');
    return;
  }
  await noticeStore.manualMatch(matchingNotice.value.id, selectedRingId.value);
  ElMessage.success('已人工匹配');
  matchVisible.value = false;
}
</script>

<template>
  <div>
    <h2 class="page-title">回收通报</h2>
    <p class="page-desc">
      环志中心通报（环号 / 回收地 / 回收日期）与本站台账（鸟种 / 量度 / 鸟点）各记各的。接进统计台时按归属分开：
      回收地、回收日期认中心的，鸟种、量度、鸟点认本站的；环号本站没有就先挂着等人工处理，不凭空生成记录。
    </p>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-badge" style="border-left: 3px solid #c77700">
          <div class="stat-label">挂起通报</div>
          <div class="stat-value" style="color: #c77700">
            {{ breakdown.pending }}
            <span class="stat-unit">条</span>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-badge" style="border-left: 3px solid #2f7d32">
          <div class="stat-label">已匹配</div>
          <div class="stat-value" style="color: #2f7d32">
            {{ breakdown.matched }}
            <span class="stat-unit">条</span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>导入中心通报</span>
          <el-button link type="primary" @click="addVisible = true">新增单条</el-button>
        </div>
      </template>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="4"
        placeholder="每行一条，支持「环号,回收地,回收日期」或「环号 回收日期 回收地」，如：
A-10231,黄河口南岸,2026-09-15
B-99999 2026-09-20 辽东湾北岸"
      />
      <div class="import-actions">
        <el-button type="primary" :loading="importing" @click="doImport">批量导入</el-button>
        <el-button :disabled="noticeStore.pendingCount === 0" @click="retryAll">全部重试</el-button>
        <span class="import-hint">逐条独立处理：已写进本站的部分保留，失败的按中心那边重试即可</span>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>通报列表</span>
          <span class="card-note">挂起 {{ breakdown.pending }} · 已匹配 {{ breakdown.matched }}</span>
        </div>
      </template>

      <FilterBar
        :fields="[
          { key: 'status', label: '状态', options: ['挂起', '已匹配'], width: 120 },
        ]"
        keyword-placeholder="搜索环号 / 回收地 / 鸟种 / 鸟点"
        :result-count="visibleRows.length"
        :total-count="combinedRows.length"
      />

      <EmptyPanel v-if="visibleRows.length === 0" description="暂无回收通报，可在上方导入中心通报" />

      <el-table v-else :data="visibleRows" size="small" border>
        <el-table-column prop="notice.ringNo" label="环号" width="110" />
        <el-table-column prop="notice.recoverySite" label="回收地（中心）" min-width="140" show-overflow-tooltip />
        <el-table-column label="回收日期（中心）" width="120">
          <template #default="scope">{{ formatDate(scope.row.notice.recoveryDate) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="scope">
            <el-tag :type="NOTICE_STATUS_COLOR[scope.row.notice.status as NoticeStatus]" size="small">
              {{ NOTICE_STATUS_LABEL[scope.row.notice.status as NoticeStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="鸟种（本站）" width="120">
          <template #default="scope">{{ scope.row.speciesCn }}</template>
        </el-table-column>
        <el-table-column label="鸟点（本站）" width="140" show-overflow-tooltip>
          <template #default="scope">{{ scope.row.siteName }}</template>
        </el-table-column>
        <el-table-column label="量度（本站）" width="160">
          <template #default="scope">
            <span v-if="scope.row.morph">
              翅 {{ scope.row.morph.wingLength }}mm · 体重 {{ scope.row.morph.weight }}g
            </span>
            <span v-else class="cell-empty">—</span>
          </template>
        </el-table-column>
        <el-table-column label="失败原因 / 重试" min-width="160">
          <template #default="scope">
            <div v-if="scope.row.notice.status === 'pending'" class="fail-cell">
              <span class="fail-reason">{{ scope.row.notice.failReason }}</span>
              <span class="retry-count">已重试 {{ scope.row.notice.retryCount }} 次</span>
            </div>
            <span v-else class="cell-empty">
              匹配于 {{ formatDate(scope.row.notice.retriedAt ?? scope.row.notice.receivedAt) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="scope">
            <el-button v-if="scope.row.notice.status === 'pending'" link type="primary" @click="retry(scope.row)">重试</el-button>
            <el-button link type="primary" @click="openManualMatch(scope.row)">人工匹配</el-button>
            <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="addVisible" title="新增单条通报" width="480px">
      <el-form label-width="90px">
        <el-form-item label="环号" required>
          <el-input v-model="addForm.ringNo" placeholder="如 A-10231" />
        </el-form-item>
        <el-form-item label="回收地">
          <el-input v-model="addForm.recoverySite" placeholder="如 黄河口南岸" />
        </el-form-item>
        <el-form-item label="回收日期">
          <el-date-picker v-model="addForm.recoveryDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="matchVisible" title="人工匹配到本站环志记录" width="640px">
      <p class="match-hint">
        通报环号 <b>{{ matchingNotice?.ringNo }}</b>，回收地 {{ matchingNotice?.recoverySite }}（中心）。
        选择本站一条环志记录匹配，鸟种 / 量度 / 鸟点以该记录为准。
      </p>
      <el-input v-model="matchKeyword" placeholder="搜索环号 / 鸟种 / 学名" class="match-search" clearable />
      <el-table :data="matchOptions" size="small" border max-height="320" @row-click="(row: RingRecord) => (selectedRingId = row.id)">
        <el-table-column width="50">
          <template #default="scope">
            <el-radio-group v-model="selectedRingId">
              <el-radio :value="scope.row.id">&nbsp;</el-radio>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column prop="ringNo" label="环号" width="110" />
        <el-table-column prop="speciesCn" label="鸟种" width="120" />
        <el-table-column prop="speciesSci" label="学名" show-overflow-tooltip />
        <el-table-column label="环志日期" width="120">
          <template #default="scope">{{ formatDate(scope.row.ringDate) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="matchVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmMatch">确认匹配</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #1f4a44;
}
.page-desc {
  margin: 0 0 14px;
  color: #6f8480;
  font-size: 13px;
}
.stat-row {
  margin-bottom: 12px;
}
.stat-row .el-col {
  margin-bottom: 12px;
}
.stat-badge {
  border-radius: 6px;
}
.stat-label {
  font-size: 12px;
  color: #8a7a68;
}
.stat-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.5;
}
.stat-unit {
  font-size: 12px;
  color: #8a7a68;
  margin-left: 4px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a99a5;
}
.import-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.import-hint {
  font-size: 12px;
  color: #8a99a5;
}
.cell-empty {
  color: #b6c2be;
}
.fail-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fail-reason {
  color: #c77700;
  font-size: 12px;
}
.retry-count {
  color: #b6c2be;
  font-size: 12px;
}
.match-hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: #6f8480;
}
.match-search {
  margin-bottom: 10px;
}
</style>
