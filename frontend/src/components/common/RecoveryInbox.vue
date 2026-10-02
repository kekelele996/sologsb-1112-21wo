<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import { Refresh, Upload, Download, Connection } from '@element-plus/icons-vue';
import { useRecoveryStore, getCenterEndpoint, setCenterEndpoint } from '../../stores/recoveryStore';
import { useRingStore } from '../../stores/ringStore';
import { useSiteStore } from '../../stores/siteStore';
import { useMeasureStore } from '../../stores/measureStore';
import { RECOVERY_STATUS_TAG, type RecoveryReport } from '../../types/recovery';
import {
  SAMPLE_BULLETIN,
  batchToParsed,
  fetchBulletin,
  parseBulletin,
  type ParsedBulletin,
} from '../../utils/recoveryCenter';
import { recoveredSpeciesCount, recoverySummary, recoveryViews } from '../../utils/stats';
import { downloadText } from '../../utils/export';
import { formatDate } from '../../utils/format';

const recoveryStore = useRecoveryStore();
const ringStore = useRingStore();
const siteStore = useSiteStore();
const measureStore = useMeasureStore();

const activeTab = ref<'matched' | 'pending'>('matched');

const views = computed(() =>
  recoveryViews(recoveryStore.reports, ringStore.rings, measureStore.morphs, siteStore.sites),
);
const matchedViews = computed(() =>
  views.value
    .filter((view) => view.report.status === '已匹配')
    .sort((a, b) => b.report.recoveryDate.localeCompare(a.report.recoveryDate)),
);
const pendingViews = computed(() =>
  views.value
    .filter((view) => view.report.status === '待处理')
    .sort((a, b) => a.report.recoveryDate.localeCompare(b.report.recoveryDate)),
);
const summary = computed(() => recoverySummary(recoveryStore.reports, ringStore.rings));
const recoveredSpecies = computed(() => recoveredSpeciesCount(matchedViews.value));

/** 本站环号选项，挂起记录人工匹配用（环号不一致也允许指定，确认权在人） */
const ringOptions = computed(() =>
  [...ringStore.rings]
    .sort((a, b) => a.ringDate.localeCompare(b.ringDate))
    .map((ring) => ({
      value: ring.id,
      label: `${ring.ringNo} · ${ring.speciesCn} · ${siteStore.siteName(ring.siteId)} · ${formatDate(ring.ringDate)}`,
    })),
);

/* ---------------- 接入通报（粘贴 JSON / 选文件） ---------------- */

const importVisible = ref(false);
const bulletinText = ref('');
const parsed = ref<ParsedBulletin | null>(null);
const parseError = ref('');
const importing = ref(false);

function openImport(sample = false) {
  importVisible.value = true;
  parseError.value = '';
  parsed.value = null;
  bulletinText.value = sample ? JSON.stringify(SAMPLE_BULLETIN, null, 2) : '';
}

function reviewText() {
  parseError.value = '';
  parsed.value = null;
  if (!bulletinText.value.trim()) {
    parseError.value = '通报内容为空';
    return;
  }
  try {
    parsed.value = parseBulletin(bulletinText.value);
  } catch (error) {
    parseError.value = (error as Error).message;
  }
}

async function handleFile(uploadFile: UploadFile) {
  if (!uploadFile.raw) return false;
  importVisible.value = true;
  bulletinText.value = await uploadFile.raw.text();
  reviewText();
  return false;
}

/**
 * 确认接入：逐行落库。整批解析失败（报文坏）不落任何本站记录；
 * 单行失败只挂 failed，已写入的留着，随后按中心报文重试即可。
 */
async function confirmImport() {
  if (!parsed.value) {
    reviewText();
    if (!parsed.value) return;
  }
  importing.value = true;
  try {
    const result = await recoveryStore.importRows(parsed.value.batchNo, parsed.value.items);
    const parts = [`批次 ${result.batchNo}`, `新增 ${result.inserted}`, `刷新 ${result.updated}`, `匹配 ${result.matched}`, `挂起 ${result.pending}`];
    if (result.failed.length) {
      ElMessage.warning(`接入完成但 ${result.failed.length} 行落库失败（已写入部分保留，可按中心报文重试）：${parts.join('，')}`);
    } else {
      ElMessage.success(`中心通报已接入：${parts.join('，')}`);
    }
    if (parsed.value.errors.length) {
      ElMessage.warning(`${parsed.value.errors.length} 行通报字段不合规被跳过，请按中心原文核对后重试`);
    }
    importVisible.value = false;
    activeTab.value = result.pending > 0 ? 'pending' : 'matched';
  } finally {
    importing.value = false;
  }
}

function downloadTemplate() {
  downloadText('center-recovery-template.json', JSON.stringify(SAMPLE_BULLETIN, null, 2));
}

/* ---------------- 按中心地址拉取与重试 ---------------- */

const pulling = ref(false);
const endpoint = ref(getCenterEndpoint());

async function pullFromCenter(isRetry = false) {
  if (!endpoint.value.trim()) {
    ElMessage.info('请先填写环志中心通报地址，或用「粘贴/文件接入」');
    return;
  }
  setCenterEndpoint(endpoint.value);
  pulling.value = true;
  try {
    const { batch } = await fetchBulletin(endpoint.value);
    const parsedBatch = batchToParsed(batch);
    const result = await recoveryStore.importRows(parsedBatch.batchNo, parsedBatch.items);
    await recoveryStore.clearFetchError();
    ElMessage.success(
      `${isRetry ? '重试' : '拉取'}成功：新增 ${result.inserted} / 刷新 ${result.updated} / 匹配 ${result.matched} / 挂起 ${result.pending}`,
    );
    activeTab.value = result.pending > 0 ? 'pending' : 'matched';
  } catch (error) {
    // 拉取/解析失败：不动本站已写入的通报，只记录错误供按中心口径重试
    await recoveryStore.markFetchError((error as Error).message);
    ElMessage.error(`中心通报接入失败：${(error as Error).message}（本站已接入的部分保留，可直接重试）`);
  } finally {
    pulling.value = false;
  }
}

async function rematch() {
  const resolved = await recoveryStore.rematchPending();
  if (resolved > 0) {
    ElMessage.success(`重新比对完成，${resolved} 条挂起记录已匹配本站环志`);
  } else {
    ElMessage.info('仍无挂起记录能在本站台账找到对应环号，请先补登环志记录或人工指定');
  }
}

/* ---------------- 人工处理挂起 ---------------- */

const assignVisible = ref(false);
const assigning = ref<RecoveryReport | null>(null);
const assignRingId = ref('');

function openAssign(view: { report: RecoveryReport }) {
  assigning.value = view.report;
  const sameRing = ringStore.historyOf(view.report.ringNo)[0];
  assignRingId.value = sameRing?.id ?? ringOptions.value[0]?.value ?? '';
  assignVisible.value = true;
}

async function confirmAssign() {
  if (!assigning.value || !assignRingId.value) return;
  const target = ringStore.rings.find((ring) => ring.id === assignRingId.value);
  if (target && target.ringNo.trim().toLowerCase() !== assigning.value.ringNo.trim().toLowerCase()) {
    const ok = await ElMessageBox.confirm(
      `中心通报环号为「${assigning.value.ringNo}」，所选本站记录环号为「${target.ringNo}」，两者不一致。确认仍按人工判断匹配？`,
      '环号不一致',
      { type: 'warning', confirmButtonText: '确认人工匹配', cancelButtonText: '再想想' },
    )
      .then(() => true)
      .catch(() => false);
    if (!ok) return;
  }
  await recoveryStore.assignRing(assigning.value.id, assignRingId.value);
  ElMessage.success('已人工匹配到本站环志记录（鸟种 / 量度 / 鸟点按本站台账显示）');
  assignVisible.value = false;
}

async function unassign(view: { report: RecoveryReport }) {
  const ok = await ElMessageBox.confirm(`解除「${view.report.ringNo}」与本站环志记录的匹配并退回挂起？`, '解除匹配', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!ok) return;
  await recoveryStore.unassign(view.report.id);
  ElMessage.success('已解除匹配，通报挂起待处理');
}

async function removeReport(view: { report: RecoveryReport }) {
  const ok = await ElMessageBox.confirm(
    `删除本站侧通报「${view.report.ringNo}」？中心报文仍在，重新接入会原样回来；本站环志台账不受影响。`,
    '删除通报',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!ok) return;
  await recoveryStore.remove(view.report.id);
  ElMessage.success('已删除本站侧通报记录');
}
</script>

<template>
  <el-card shadow="never" class="recovery-block">
    <template #header>
      <div class="head">
        <div class="head-title">
          <span>环志中心回收通报</span>
          <el-tag size="small" type="info" effect="plain">回收地 / 回收日期认中心</el-tag>
          <el-tag size="small" type="success" effect="plain">鸟种 / 量度 / 鸟点认本站</el-tag>
        </div>
        <div class="head-actions">
          <el-button size="small" :icon="Refresh" :loading="pulling" @click="pullFromCenter(false)">
            按中心拉取{{ recoveryStore.lastFetchError ? '（重试）' : '' }}
          </el-button>
          <el-button size="small" :icon="Upload" @click="openImport(false)">粘贴 / 文件接入</el-button>
          <el-button size="small" :icon="Connection" @click="rematch">重新比对挂起</el-button>
        </div>
      </div>
    </template>

    <el-alert
      v-if="recoveryStore.lastFetchError"
      class="fetch-error"
      type="error"
      :closable="false"
      show-icon
      title="上次按中心拉取失败"
      :description="`${recoveryStore.lastFetchError} —— 已写进本站的通报保留，未写入的等按中心口径重试。`"
    >
      <el-button size="small" type="danger" plain :loading="pulling" @click="pullFromCenter(true)">立即按中心重试</el-button>
    </el-alert>

    <el-row :gutter="12" class="summary-row">
      <el-col :xs="12" :md="6">
        <div class="summary-item"><span class="num">{{ summary.total }}</span><span class="lbl">中心通报（条）</span></div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="summary-item"><span class="num ok">{{ summary.matched }}</span><span class="lbl">已匹配回收</span></div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="summary-item"><span class="num warn">{{ summary.pending }}</span><span class="lbl">挂起待人工处理</span></div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="summary-item"><span class="num muted">{{ summary.unrecovered }}</span><span class="lbl">本站环号未回收（去重）</span></div>
      </el-col>
    </el-row>

    <el-tabs v-model="activeTab" class="tabs">
      <el-tab-pane :label="`已匹配（${matchedViews.length}）`" name="matched">
        <el-empty v-if="matchedViews.length === 0" description="还没有匹配到本站环志的中心回收通报" :image-size="70">
          <el-button size="small" type="primary" @click="openImport(true)">接入示例通报试试</el-button>
        </el-empty>
        <el-table v-else :data="matchedViews" size="small" border>
          <el-table-column label="环号" width="100">
            <template #default="{ row }">
              <strong>{{ row.report.ringNo }}</strong>
              <div v-if="row.ring && row.ring.ringNo !== row.report.ringNo" class="mismatch">本站环号 {{ row.ring.ringNo }}</div>
            </template>
          </el-table-column>
          <el-table-column label="回收地（中心）" prop="report.recoveryPlace" min-width="150" show-overflow-tooltip />
          <el-table-column label="回收日期（中心）" width="120">
            <template #default="{ row }">{{ row.report.recoveryDate }}</template>
          </el-table-column>
          <el-table-column label="鸟种（本站）" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <template v-if="row.ring">{{ row.ring.speciesCn }} <span class="sci">{{ row.ring.speciesSci }}</span></template>
              <span v-else class="muted">本站记录已缺失</span>
            </template>
          </el-table-column>
          <el-table-column label="量度（本站）" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <template v-if="row.morph">翅 {{ row.morph.wingLength }}mm · 体重 {{ row.morph.weight }}g</template>
              <span v-else class="muted">未量度</span>
            </template>
          </el-table-column>
          <el-table-column label="鸟点（本站）" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.site ? `${row.site.siteNo} · ${row.site.name}` : '—' }}</template>
          </el-table-column>
          <el-table-column label="批次 / 匹配" width="150">
            <template #default="{ row }">
              <div class="dim">{{ row.report.batchNo }}</div>
              <el-tag size="small" :type="RECOVERY_STATUS_TAG[row.report.status as RecoveryReport['status']]" effect="plain">
                {{ row.report.matchedBy }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="unassign(row)">解除匹配</el-button>
              <el-button link type="danger" @click="removeReport(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="recoveredSpecies.length" class="species-strip">
          <span class="strip-title">回收鸟种（认本站鸟种）：</span>
          <el-tag v-for="item in recoveredSpecies" :key="item.speciesCn" size="small" effect="plain" class="species-tag">
            {{ item.speciesCn }} × {{ item.count }}
          </el-tag>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`挂起待处理（${pendingViews.length}）`" name="pending">
        <el-alert
          v-if="pendingViews.length"
          class="pending-hint"
          type="warning"
          :closable="false"
          show-icon
          title="这些环号在本站台账查不到，已按中心通报挂起"
          description="可先去「环志记录」补登该环号后点「重新比对挂起」；也可人工指定到一条本站记录。系统不会凭空生成环志记录。"
        />
        <el-empty v-else description="没有挂起通报，中心环号都能在本站台账找到" :image-size="70" />
        <el-table v-if="pendingViews.length" :data="pendingViews" size="small" border>
          <el-table-column label="环号（中心）" width="120">
            <template #default="{ row }"><strong>{{ row.report.ringNo }}</strong></template>
          </el-table-column>
          <el-table-column label="回收地（中心）" prop="report.recoveryPlace" min-width="160" show-overflow-tooltip />
          <el-table-column label="回收日期（中心）" width="130">
            <template #default="{ row }">{{ row.report.recoveryDate }}</template>
          </el-table-column>
          <el-table-column label="通报批次" prop="report.batchNo" width="140" />
          <el-table-column label="本站情况" min-width="180">
            <template #default>
              <span class="muted">本站无此环号，鸟种 / 量度 / 鸟点缺省</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openAssign(row)">人工指定本站记录</el-button>
              <el-button link type="danger" @click="removeReport(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="importVisible" title="接入环志中心回收通报" width="720px">
      <el-alert
        type="info"
        :closable="false"
        class="import-note"
        title="通报只需包含环号、回收地、回收日期；鸟种 / 量度 / 鸟点一律认本站台账，本站无此环号则挂起等人工处理，不会凭空生成记录。"
        show-icon
      />
      <div class="import-toolbar">
        <el-upload :auto-upload="false" :show-file-list="false" accept=".json,application/json" :on-change="handleFile">
          <el-button size="small" :icon="Upload">选择通报文件</el-button>
        </el-upload>
        <el-button size="small" :icon="Download" @click="downloadTemplate">下载通报模板</el-button>
        <el-button size="small" link type="primary" @click="openImport(true)">填入中心示例通报</el-button>
      </div>
      <el-input v-model="bulletinText" type="textarea" :rows="9" placeholder='{"batchNo":"HB-2024-R07","items":[{"ringNo":"A-10231","recoveryPlace":"辽宁盘锦鸳鸯沟","recoveryDate":"2026-09-20"}]}' @input="parseError = ''" />
      <div class="review-row">
        <el-button size="small" @click="reviewText">校验报文</el-button>
        <el-tag v-if="parsed" size="small" type="success" effect="plain">
          批次 {{ parsed.batchNo }} · 有效 {{ parsed.items.length }} 行<template v-if="parsed.errors.length"> · {{ parsed.errors.length }} 行不合规</template>
        </el-tag>
        <span v-if="parseError" class="err">{{ parseError }}</span>
      </div>
      <el-table v-if="parsed && parsed.items.length" :data="parsed.items" size="small" border max-height="180" class="preview-table">
        <el-table-column prop="ringNo" label="环号" width="110" />
        <el-table-column prop="recoveryPlace" label="回收地" min-width="140" show-overflow-tooltip />
        <el-table-column prop="recoveryDate" label="回收日期" width="110" />
      </el-table>
      <el-table v-if="parsed && parsed.errors.length" :data="parsed.errors" size="small" border max-height="140" class="preview-table">
        <el-table-column prop="index" label="行号" width="70" />
        <el-table-column prop="message" label="问题" min-width="160" show-overflow-tooltip />
      </el-table>

      <el-divider content-position="left">或按中心地址拉取（失败按中心口径重试）</el-divider>
      <div class="endpoint-row">
        <el-input v-model="endpoint" size="small" placeholder="中心通报 JSON 地址（可选，由中心提供）" clearable />
        <el-button size="small" :loading="pulling" @click="pullFromCenter(false)">拉取 / 重试</el-button>
      </div>

      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" :disabled="!parsed || parsed.items.length === 0" @click="confirmImport">
          确认接入本站
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignVisible" title="挂起通报 · 人工指定本站环志记录" width="560px">
      <div v-if="assigning" class="assign-body">
        <p class="assign-line">
          中心环号 <strong>{{ assigning.ringNo }}</strong>，回收于 {{ assigning.recoveryPlace }}（{{ assigning.recoveryDate }}）
        </p>
        <p class="dim">指定后该通报的鸟种 / 量度 / 鸟点按所选本站记录显示；环号不一致时需你二次确认。</p>
        <el-select v-model="assignRingId" filterable placeholder="选择本站环志记录" style="width: 100%">
          <el-option v-for="opt in ringOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!assignRingId" @click="confirmAssign">确认人工匹配</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.recovery-block {
  margin-top: 4px;
  border-radius: 8px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #1f4a44;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.fetch-error {
  margin-bottom: 12px;
}
.summary-row {
  margin: 4px 0 8px;
}
.summary-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  background: #f6faf8;
  border: 1px solid #e0ece7;
  border-radius: 6px;
  padding: 8px 12px;
}
.summary-item .num {
  font-size: 22px;
  font-weight: 700;
  color: #1f4a44;
}
.summary-item .num.ok {
  color: #2f7d32;
}
.summary-item .num.warn {
  color: #c77700;
}
.summary-item .num.muted {
  color: #6f8480;
}
.summary-item .lbl {
  font-size: 12px;
  color: #6f8480;
}
.tabs {
  margin-top: 4px;
}
.sci {
  color: #8a99a5;
  font-size: 12px;
}
.muted {
  color: #a3968a;
}
.dim {
  color: #8a99a5;
  font-size: 12px;
}
.mismatch {
  color: #c77700;
  font-size: 12px;
}
.species-strip {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.strip-title {
  font-size: 12px;
  color: #6f8480;
}
.species-tag {
  border-radius: 4px;
}
.pending-hint {
  margin-bottom: 10px;
}
.import-note {
  margin-bottom: 10px;
}
.import-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.review-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
}
.review-row .err {
  color: #c62828;
  font-size: 12px;
}
.preview-table {
  margin-bottom: 8px;
}
.endpoint-row {
  display: flex;
  gap: 8px;
}
.assign-body .assign-line {
  margin: 0 0 8px;
  color: #2f4a44;
}
</style>
