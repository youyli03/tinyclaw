/* ─────────────────────────────────────────────────────────────────
   tinyclaw dashboard — main.js
   Vue 3 CDN，Chart.js CDN，原生 fetch
   ───────────────────────────────────────────────────────────────── */

const { createApp, ref, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

// ── 颜色常量 ─────────────────────────────────────────────────────────────────
const C = {
  accent:  '#4F7EF8',
  accent2: '#AF87FF',
  green:   '#34C785',
  orange:  '#FF9F0A',
  red:     '#FF6961',
  cyan:    '#0891B2',
  purple:  '#8B5CF6',
  t3:      '#B0B8D4',
  border:  '#E8EEFF',
  card2:   '#F0F4FF',
};

// ── Chart.js 通用默认配置 ─────────────────────────────────────────────────────
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = C.t3;

function baseChartOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#fff',
        borderColor: C.border,
        borderWidth: 1,
        titleColor: '#1C1C2E',
        bodyColor: '#636380',
        padding: 10,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: C.border },
        ticks: { color: C.t3 },
      },
      y: {
        grid: { color: C.border, lineWidth: 0.8 },
        border: { dash: [4, 4], color: 'transparent' },
        ticks: { color: C.t3 },
      },
    },
    ...extra,
  };
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(isoOrTs) {
  if (!isoOrTs) return '—';
  const d = new Date(typeof isoOrTs === 'number' ? isoOrTs * 1000 : isoOrTs);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}m 前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h 前`;
  return `${Math.floor(hrs / 24)}d 前`;
}

function shortName(msg) {
  if (!msg) return '—';
  // 取前 20 个字符
  return msg.length > 24 ? msg.slice(0, 24) + '…' : msg;
}

function scheduleStr(job) {
  if (job.type === 'daily') return `${job.timeOfDay} / 天`;
  if (job.type === 'every') {
    const s = job.intervalSecs;
    if (s < 120) return `每 ${s}s`;
    if (s < 3600) return `每 ${Math.round(s / 60)}m`;
    return `每 ${Math.round(s / 3600)}h`;
  }
  if (job.type === 'once') return `一次性`;
  return job.type;
}

function statusText(job) {
  if (!job.enabled) return '已停用';
  if (!job.lastRunStatus) return '待运行';
  return job.lastRunStatus === 'success' ? '成功' : '失败';
}

function statusClass(job) {
  if (!job.enabled) return 'status-badge status-disabled';
  if (!job.lastRunStatus) return 'status-badge status-pending';
  return job.lastRunStatus === 'success'
    ? 'status-badge status-success'
    : 'status-badge status-error';
}

// ── Chart 管理（避免重复创建） ─────────────────────────────────────────────────
const charts = {};

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function createOrUpdateChart(id, config) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, config);
  charts[id] = chart;
  return chart;
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function drawSparkline(id, data, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  destroyChart(id);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 36);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        borderColor: color,
        borderWidth: 1.8,
        pointRadius: 0,
        fill: true,
        backgroundColor: grad,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
      animation: false,
    },
  });
}

// ── Vue App ───────────────────────────────────────────────────────────────────
const app = createApp({
  setup() {
    const page = ref('overview');

    // ── 时间 ────────────────────────────────────────────────────────────────
    const currentTime = ref('');
    const dateStr = ref('');
    const updateTime = () => {
      const now = new Date();
      currentTime.value = now.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      dateStr.value = now.toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
      });
    };
    updateTime();
    const timeTimer = setInterval(updateTime, 1000);

    // ── 实时数据 ─────────────────────────────────────────────────────────────
    const stats = ref(null);
    const cronJobs = ref([]);

    const statCards = computed(() => {
      const s = stats.value;
      const jobs = cronJobs.value;
      const active = jobs.filter(j => j.enabled).length;

      // 从 metrics 里取最新电费/请求（如果有）
      const elecVal = latestMetricVal.value['electric/balance'] ?? '—';
      const copilotVal = latestMetricVal.value['copilot/daily_count'] ?? '—';

      return [
        {
          key: 'electric', label: '电费余额',
          value: elecVal !== '—' ? `¥ ${Number(elecVal).toFixed(2)}` : '¥ —',
          sub1: '单位：人民币元', sub2: '点击指标页查看趋势',
          color: C.accent, spark: latestSpark.value['electric/balance'] || [],
        },
        {
          key: 'copilot', label: '高级请求',
          value: copilotVal !== '—' ? String(Math.round(Number(copilotVal))) : '—',
          sub1: '今日用量', sub2: '点击指标页查看趋势',
          color: C.accent2, spark: latestSpark.value['copilot/daily_count'] || [],
        },
        {
          key: 'cpu', label: 'CPU',
          value: s ? `${s.cpu_percent} %` : '—',
          sub1: `峰值 —`, sub2: '实时采样',
          color: C.orange, spark: cpuHistory.value,
        },
        {
          key: 'mem', label: '内存',
          value: s ? `${(s.mem_used_mb / 1024).toFixed(1)} GB` : '—',
          sub1: s ? `共 ${(s.mem_total_mb / 1024).toFixed(0)} GB` : '—',
          sub2: s ? `可用 ${((s.mem_total_mb - s.mem_used_mb) / 1024).toFixed(1)} GB` : '',
          color: C.green, spark: memHistory.value,
        },
        {
          key: 'disk', label: '磁盘',
          value: s ? `${s.disk_used_gb} GB` : '—',
          sub1: s ? `共 ${s.disk_total_gb} GB` : '—',
          sub2: s ? `占用 ${Math.round(s.disk_used_gb / s.disk_total_gb * 100)}%` : '',
          color: C.cyan, spark: [],
        },
        {
          key: 'cron', label: 'Cron',
          value: `${active} / ${jobs.length}`,
          sub1: `${jobs.length - active} 已停用`, sub2: '活跃任务数',
          color: C.purple, spark: [],
        },
      ];
    });

    const cronActive = computed(() => cronJobs.value.filter(j => j.enabled).length);
    const cronTotal = computed(() => cronJobs.value.length);

    // CPU/内存历史（最近 20 次 stats 采样用于 sparkline）
    const cpuHistory = ref([]);
    const memHistory = ref([]);

    // 最新指标值（from DB）
    const latestMetricVal = ref({});
    const latestSpark = ref({});

    async function fetchStats() {
      try {
        const data = await fetch('/api/stats').then(r => r.json());
        stats.value = data;
        // 追加历史
        cpuHistory.value = [...cpuHistory.value.slice(-19), data.cpu_percent];
        memHistory.value = [...memHistory.value.slice(-19),
          Math.round(data.mem_used_mb / data.mem_total_mb * 100)];
      } catch (e) { console.warn('fetchStats failed', e); }
    }

    async function fetchCron() {
      try {
        const data = await fetch('/api/cron').then(r => r.json());
        cronJobs.value = data.jobs || [];
      } catch (e) { console.warn('fetchCron failed', e); }
    }

    async function fetchLatestMetrics() {
      try {
        const keysData = await fetch('/api/metric-keys').then(r => r.json());
        for (const { category, key } of (keysData.keys || [])) {
          const data = await fetch(`/api/metrics?category=${category}&key=${key}&days=14`).then(r => r.json());
          const rows = data.rows || [];
          if (rows.length) {
            const k = `${category}/${key}`;
            latestMetricVal.value[k] = rows[rows.length - 1].value;
            latestSpark.value[k] = rows.map(r => r.value);
          }
        }
      } catch (e) { console.warn('fetchLatestMetrics failed', e); }
    }

    // ── 图表绘制 ─────────────────────────────────────────────────────────────
    async function drawOverviewCharts() {
      // 电费图
      try {
        const data = await fetch('/api/metrics?category=electric&key=balance&days=30').then(r => r.json());
        const rows = data.rows || [];
        const labels = rows.map(r => fmtTime(r.ts));
        const values = rows.map(r => r.value);
        const canvas = document.getElementById('chart-electric');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, 0, 200);
          grad.addColorStop(0, C.accent + '30');
          grad.addColorStop(1, C.accent + '00');
          createOrUpdateChart('chart-electric', {
            type: 'line',
            data: {
              labels,
              datasets: [{
                data: values,
                borderColor: C.accent,
                borderWidth: 2,
                backgroundColor: grad,
                fill: true,
                tension: 0.4,
                pointRadius: 2,
                pointHoverRadius: 5,
              }],
            },
            options: baseChartOpts(),
          });
        }
      } catch (e) { console.warn('electric chart failed', e); }

      // 请求柱图
      try {
        const data = await fetch('/api/metrics?category=copilot&key=daily_count&days=14').then(r => r.json());
        const rows = data.rows || [];
        const labels = rows.map(r => fmtTime(r.ts));
        const values = rows.map(r => r.value);
        const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        createOrUpdateChart('chart-copilot', {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              data: values,
              backgroundColor: values.map(v => v > avg * 1.2 ? C.red + 'CC' : C.accent + 'CC'),
              borderRadius: 4,
            }],
          },
          options: {
            ...baseChartOpts(),
            plugins: {
              ...baseChartOpts().plugins,
              annotation: undefined,
            },
          },
        });
      } catch (e) { console.warn('copilot chart failed', e); }

      // 系统折线
      try {
        const data = await fetch('/api/metrics?category=system&days=1').then(r => r.json());
        const rows = data.rows || [];
        const labels = rows.map(r => {
          const d = new Date(r.ts * 1000);
          return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        });
        const cpuData = rows.map(r => r.cpu_percent);
        const memData = rows.map(r => Math.round(r.mem_used_mb / r.mem_total_mb * 100));

        const canvas = document.getElementById('chart-system');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const gradCpu = ctx.createLinearGradient(0, 0, 0, 240);
          gradCpu.addColorStop(0, C.accent + '25');
          gradCpu.addColorStop(1, C.accent + '00');
          const gradMem = ctx.createLinearGradient(0, 0, 0, 240);
          gradMem.addColorStop(0, C.green + '25');
          gradMem.addColorStop(1, C.green + '00');
          createOrUpdateChart('chart-system', {
            type: 'line',
            data: {
              labels,
              datasets: [
                {
                  label: 'CPU %',
                  data: cpuData,
                  borderColor: C.accent,
                  borderWidth: 1.8,
                  backgroundColor: gradCpu,
                  fill: true,
                  tension: 0.4,
                  pointRadius: 0,
                },
                {
                  label: '内存 %',
                  data: memData,
                  borderColor: C.green,
                  borderWidth: 1.8,
                  backgroundColor: gradMem,
                  fill: true,
                  tension: 0.4,
                  pointRadius: 0,
                },
              ],
            },
            options: baseChartOpts({ scales: {
              ...baseChartOpts().scales,
              y: { ...baseChartOpts().scales.y, min: 0, max: 100 },
            }}),
          });
        }
      } catch (e) { console.warn('system chart failed', e); }
    }

    function drawSparklines() {
      nextTick(() => {
        for (const c of statCards.value) {
          if (c.spark && c.spark.length) {
            drawSparkline('spark-' + c.key, c.spark, c.color);
          }
        }
      });
    }

    // ── 指标页 ───────────────────────────────────────────────────────────────
    const metricKeys = ref([]);
    const mCategory = ref('');
    const mKey = ref('');
    const mDays = ref('30');

    const filteredKeys = computed(() =>
      metricKeys.value.filter(k => k.category === mCategory.value)
    );

    function onMetricKeyChange() { mKey.value = ''; }

    async function fetchMetricKeys() {
      try {
        const data = await fetch('/api/metric-keys').then(r => r.json());
        metricKeys.value = data.keys || [];
      } catch (e) { console.warn('fetchMetricKeys failed', e); }
    }

    async function loadMetricChart() {
      if (!mCategory.value || !mKey.value) return;
      try {
        const data = await fetch(
          `/api/metrics?category=${mCategory.value}&key=${mKey.value}&days=${mDays.value}`
        ).then(r => r.json());
        const rows = data.rows || [];
        await nextTick();
        const canvas = document.getElementById('chart-metrics');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 300);
        grad.addColorStop(0, C.accent + '30');
        grad.addColorStop(1, C.accent + '00');
        createOrUpdateChart('chart-metrics', {
          type: 'line',
          data: {
            labels: rows.map(r => fmtTime(r.ts)),
            datasets: [{
              label: `${mCategory.value}/${mKey.value}`,
              data: rows.map(r => r.value),
              borderColor: C.accent,
              borderWidth: 2,
              backgroundColor: grad,
              fill: true,
              tension: 0.4,
              pointRadius: 3,
              pointHoverRadius: 6,
            }],
          },
          options: baseChartOpts(),
        });
      } catch (e) { console.warn('loadMetricChart failed', e); }
    }

    // ── 日报页 ───────────────────────────────────────────────────────────────
    const reportJobs = computed(() =>
      cronJobs.value.filter(j => j.recentLogs && j.recentLogs.length > 0)
    );
    const expandedReports = ref(new Set());
    function toggleReport(id) {
      const s = new Set(expandedReports.value);
      if (s.has(id)) s.delete(id); else s.add(id);
      expandedReports.value = s;
    }

    // ── 页面切换时绘图 ───────────────────────────────────────────────────────
    watch(page, async (newPage) => {
      if (newPage === 'overview') {
        await nextTick();
        await drawOverviewCharts();
        drawSparklines();
      }
      if (newPage === 'metrics') {
        await fetchMetricKeys();
      }
    });

    // ── 初始化 & 轮询 ────────────────────────────────────────────────────────
    onMounted(async () => {
      await Promise.all([fetchStats(), fetchCron(), fetchLatestMetrics()]);
      await nextTick();
      await drawOverviewCharts();
      drawSparklines();

      // 每 30 秒刷新
      const refreshTimer = setInterval(async () => {
        await Promise.all([fetchStats(), fetchCron(), fetchLatestMetrics()]);
        if (page.value === 'overview') {
          await drawOverviewCharts();
          drawSparklines();
        }
      }, 30000);

      onUnmounted(() => {
        clearInterval(refreshTimer);
        clearInterval(timeTimer);
        Object.values(charts).forEach(c => c.destroy());
      });
    });

    return {
      page, currentTime, dateStr,
      stats, statCards, cronJobs, cronActive, cronTotal,
      metricKeys, mCategory, mKey, mDays, filteredKeys,
      reportJobs, expandedReports,
      // 函数
      shortName, scheduleStr, statusText, statusClass, relativeTime, fmtTime,
      onMetricKeyChange, loadMetricChart, toggleReport,
    };
  },
});

app.mount('#app');
