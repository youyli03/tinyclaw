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
    interaction: {
      mode: 'nearest',
      axis: 'x',
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#fff',
        borderColor: C.border,
        borderWidth: 1,
        titleColor: '#1C1C2E',
        bodyColor: '#636380',
        padding: 10,
        callbacks: {
          title(items) {
            if (!items.length) return '';
            const raw = items[0].parsed.x;
            if (!raw) return '';
            const d = new Date(raw);
            return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ` +
                   `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
          },
          label(item) {
            const val = item.parsed.y;
            return `  ${item.dataset.label || '值'}：${val}`;
          },
        },
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

// 只显示 HH:MM（用于当天趋势图横轴）
function fmtHHMM(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// 时间轴配置（按真实时间均匀分布）
function timeXAxis(maxTicks = 8) {
  return {
    type: 'time',
    time: { unit: 'minute', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
    adapters: { date: {} },
    grid: { display: false },
    border: { color: C.border },
    ticks: { color: C.t3, maxTicksLimit: maxTicks, maxRotation: 0 },
  };
}

// 智能时间轴：根据天数选择合适粒度，避免多天时横轴挤满分钟刻度
function smartXAxis(days) {
  days = Number(days) || 1;
  if (days <= 1) {
    return {
      type: 'time',
      time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
      adapters: { date: {} },
      grid: { display: false },
      border: { color: C.border },
      ticks: { color: C.t3, maxTicksLimit: 8, maxRotation: 0 },
    };
  }
  if (days <= 3) {
    return {
      type: 'time',
      time: { unit: 'hour', displayFormats: { hour: 'MM/DD HH:mm' } },
      adapters: { date: {} },
      grid: { display: false },
      border: { color: C.border },
      ticks: { color: C.t3, maxTicksLimit: 12, maxRotation: 30 },
    };
  }
  if (days <= 14) {
    return {
      type: 'time',
      time: { unit: 'day', displayFormats: { day: 'MM/DD' } },
      adapters: { date: {} },
      grid: { display: false },
      border: { color: C.border },
      ticks: { color: C.t3, maxTicksLimit: 14, maxRotation: 0 },
    };
  }
  return {
    type: 'time',
    time: { unit: 'day', displayFormats: { day: 'MM/DD' } },
    adapters: { date: {} },
    grid: { display: false },
    border: { color: C.border },
    ticks: { color: C.t3, maxTicksLimit: 10, maxRotation: 0 },
  };
}

// 指标页专用 X 轴：使用 linear + callback 格式化，无需 date adapter
function metricXAxis(days) {
  days = Number(days) || 1;
  const fmt = (ms) => {
    const d = new Date(ms);
    if (days <= 1) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (days <= 3) return (d.getMonth()+1)+'/'+ d.getDate() + ' ' + d.getHours().toString().padStart(2,'0') + ':00';
    return (d.getMonth()+1) + '/' + d.getDate();
  };
  return {
    type: 'linear',
    grid: { display: false },
    border: { color: C.border },
    ticks: {
      color: C.t3,
      maxTicksLimit: days <= 1 ? 8 : days <= 7 ? 14 : 10,
      maxRotation: 0,
      callback: (val) => fmt(val),
    },
  };
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
    // ── Hash 路由:刷新后恢复 tab 与日报状态（兼容所有手机浏览器）──────────
    const VALID_PAGES = ['overview', 'metrics', 'reports', 'cron'];
    function parseURL() {
      const hash = location.hash.replace(/^#\/?/, '');
      const parts = hash.split('/');
      const pg = VALID_PAGES.includes(parts[0]) ? parts[0] : 'overview';
      return { pg, type: parts[1] || '', date: parts[2] || '' };
    }
    function pushURL(pg, type, date) {
      let h = pg;
      if (pg === 'reports' && type) {
        h += '/' + type;
        if (date) h += '/' + date;
      }
      const next = '#' + h;
      if (location.hash !== next) location.hash = next;
    }
    const _init = parseURL();
    const page = ref(_init.pg);

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
      const copilotVal = latestMetricVal.value['copilot/remaining'] ?? '—';

      return [
        {
          key: 'electric', label: '电费余额',
          value: elecVal !== '—' ? `¥ ${Number(elecVal).toFixed(2)}` : '¥ —',
          sub1: '单位：人民币元', sub2: '点击查看趋势 →',
          color: C.accent, spark: latestSpark.value['electric/balance'] || [],
          metricKey: 'electric/balance',
        },
        {
          key: 'copilot', label: '高级请求',
          value: copilotVal !== '—' ? (Number(copilotVal) < 0 ? '—' : String(Math.round(Number(copilotVal)))) : '—',
          sub1: '剩余次数', sub2: '点击查看趋势 →',
          color: C.accent2, spark: latestSpark.value['copilot/remaining'] || [],
          metricKey: 'copilot/remaining',
        },
        {
          key: 'cpu', label: 'CPU',
          value: s ? `${s.cpu_percent} %` : '—',
          sub1: `峰值 —`, sub2: '实时采样',
          color: C.orange, spark: cpuHistory.value, metricKey: null,
        },
        {
          key: 'mem', label: '内存',
          value: s ? `${(s.mem_used_mb / 1024).toFixed(1)} GB` : '—',
          sub1: s ? `共 ${(s.mem_total_mb / 1024).toFixed(0)} GB` : '—',
          sub2: s ? `可用 ${((s.mem_total_mb - s.mem_used_mb) / 1024).toFixed(1)} GB` : '',
          color: C.green, spark: memHistory.value, metricKey: null,
        },
        {
          key: 'disk', label: '磁盘',
          value: s ? `${s.disk_used_gb} GB` : '—',
          sub1: s ? `共 ${s.disk_total_gb} GB` : '—',
          sub2: s ? `占用 ${Math.round(s.disk_used_gb / s.disk_total_gb * 100)}%` : '',
          color: C.cyan, spark: [], metricKey: null,
        },
        {
          key: 'cron', label: 'Cron',
          value: `${active} / ${jobs.length}`,
          sub1: `${jobs.length - active} 已停用`, sub2: '活跃任务数',
          color: C.purple, spark: [], metricKey: null,
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
      // 电费图（今日趋势，每5分钟一条，最多288点）
      try {
        const data = await fetch('/api/metrics?category=electric&key=balance&days=1').then(r => r.json());
        const rows = data.rows || [];
        const points = rows.map(r => ({ x: r.ts * 1000, y: r.value }));
        const canvas = document.getElementById('chart-electric');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, 0, 200);
          grad.addColorStop(0, C.accent + '30');
          grad.addColorStop(1, C.accent + '00');
          createOrUpdateChart('chart-electric', {
            type: 'line',
            data: {
              datasets: [{
                label: '电费余额(元)',
                data: points,
                borderColor: C.accent,
                borderWidth: 2,
                backgroundColor: grad,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 5,
              }],
            },
            options: {
              ...baseChartOpts(),
              scales: {
                x: smartXAxis(1),
                y: { ...baseChartOpts().scales.y },
              },
            },
          });
        }
      } catch (e) { console.warn('electric chart failed', e); }

      // 高级请求剩余趋势（今日趋势，每次请求写入一条）
      try {
        const data = await fetch('/api/metrics?category=copilot&key=remaining&days=1').then(r => r.json());
        const rows = data.rows || [];
        const points = rows.filter(r => r.value >= 0).map(r => ({ x: r.ts * 1000, y: r.value }));
        const canvas2 = document.getElementById('chart-copilot');
        if (canvas2) {
          const ctx2 = canvas2.getContext('2d');
          const grad2 = ctx2.createLinearGradient(0, 0, 0, 200);
          grad2.addColorStop(0, C.accent2 + '30');
          grad2.addColorStop(1, C.accent2 + '00');
          createOrUpdateChart('chart-copilot', {
            type: 'line',
            data: {
              datasets: [{
                label: '高级请求剩余',
                data: points,
                borderColor: C.accent2,
                borderWidth: 2,
                backgroundColor: grad2,
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                pointHoverRadius: 5,
              }],
            },
            options: {
              ...baseChartOpts(),
              scales: {
                x: smartXAxis(1),
                y: { ...baseChartOpts().scales.y },
              },
            },
          });
        }
      } catch (e) { console.warn('copilot chart failed', e); }

      // 系统 CPU/内存（今日24小时，每5分钟一条）
      try {
        const data = await fetch('/api/metrics?category=system&days=1').then(r => r.json());
        const rows = data.rows || [];
        const cpuPoints = rows.map(r => ({ x: r.ts * 1000, y: r.cpu_percent }));
        const memPoints = rows.map(r => ({ x: r.ts * 1000, y: Math.round(r.mem_used_mb / r.mem_total_mb * 100) }));

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
              datasets: [
                {
                  label: 'CPU %',
                  data: cpuPoints,
                  borderColor: C.accent,
                  borderWidth: 1.8,
                  backgroundColor: gradCpu,
                  fill: true,
                  tension: 0.4,
                  pointRadius: 0,
                  pointHoverRadius: 5,
                },
                {
                  label: '内存 %',
                  data: memPoints,
                  borderColor: C.green,
                  borderWidth: 1.8,
                  backgroundColor: gradMem,
                  fill: true,
                  tension: 0.4,
                  pointRadius: 0,
                  pointHoverRadius: 5,
                },
              ],
            },
            options: {
              ...baseChartOpts(),
              scales: {
                x: smartXAxis(1),
                y: { ...baseChartOpts().scales.y, min: 0, max: 100 },
              },
            },
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
    const mDays = ref('30');

    async function fetchMetricKeys() {
      try {
        const data = await fetch('/api/metric-keys').then(r => r.json());
        metricKeys.value = data.keys || [];
      } catch (e) { console.warn('fetchMetricKeys failed', e); }
    }

    // 从概览卡片跳转到指标页
    async function navigateToMetric(categoryKey) {
      await fetchMetricKeys();
      mDays.value = '30';
      page.value = 'metrics';
      await nextTick();
      await loadAllMetricCharts();
    }

    // 加载所有指标图（每个指标独立一张图）
    async function loadAllMetricCharts() {
      if (!metricKeys.value.length) return;
      for (const k of metricKeys.value) {
        await loadOneMetricChart(k.category, k.key);
      }
    }

    async function loadOneMetricChart(category, key) {
      try {
        const data = await fetch(
          `/api/metrics?category=${category}&key=${key}&days=${mDays.value}`
        ).then(r => r.json());
        const rows = data.rows || [];
        // v-show 下 canvas 始终存在于 DOM，直接获取即可
        const chartId = `chart-m-${category}-${key}`;
        const canvas = document.getElementById(chartId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const h = canvas.clientHeight || 180;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, C.accent + '30');
        grad.addColorStop(1, C.accent + '00');
        createOrUpdateChart(chartId, {
          type: 'line',
          data: {
            datasets: [{
              label: `${category}/${key}`,
              data: rows.map(r => ({ x: r.ts * 1000, y: r.value })),
              borderColor: C.accent,
              borderWidth: 2,
              backgroundColor: grad,
              fill: true,
              tension: 0.4,
              pointRadius: Number(mDays.value) > 1 ? 2 : 0,
              pointHoverRadius: 5,
            }],
          },
          options: {
            ...baseChartOpts(),
            scales: {
              x: metricXAxis(mDays.value),
              y: { ...baseChartOpts().scales.y },
            },
          },
        });
      } catch (e) { console.warn(`loadOneMetricChart ${category}/${key} failed`, e); }
    }

    // ── 日报页 ───────────────────────────────────────────────────────────────
    const reportTypes = ref([]);
    const reportDates = ref([]);
    const rType = ref('');
    const rDate = ref('');
    const reportHtml = ref('');

    async function fetchReportTypes() {
      try {
        const data = await fetch('/api/reports').then(r => r.json());
        reportTypes.value = data.types || [];
        if (reportTypes.value.length && !rType.value) {
          await selectReportType(reportTypes.value[0].type);
        }
      } catch (e) { console.warn('fetchReportTypes failed', e); }
    }

    async function selectReportType(type, skipHash = false) {
      rType.value = type;
      rDate.value = '';
      reportHtml.value = '';
      if (!skipHash) {
        pushURL('reports', type, '');
      }
      try {
        const data = await fetch(`/api/reports?type=${encodeURIComponent(type)}`).then(r => r.json());
        reportDates.value = data.dates || [];
        if (reportDates.value.length) {
          await selectReportDate(reportDates.value[0], skipHash);
        }
      } catch (e) { console.warn('fetchReportDates failed', e); }
    }

    async function selectReportDate(date, skipHash = false) {
      rDate.value = date;
      reportHtml.value = '';
      if (!skipHash) {
        pushURL('reports', rType.value, date);
      }
      try {
        const data = await fetch(
          `/api/reports?type=${encodeURIComponent(rType.value)}&date=${encodeURIComponent(date)}`
        ).then(r => r.json());
        const md = data.content || '';
        reportHtml.value = window.marked ? window.marked.parse(md) : `<pre>${md}</pre>`;
      } catch (e) { console.warn('selectReportDate failed', e); }
    }

    // ── Cron 展开日志 ────────────────────────────────────────────────────────
    const expandedReports = ref(new Set());
    function toggleReport(id) {
      const s = new Set(expandedReports.value);
      if (s.has(id)) s.delete(id); else s.add(id);
      expandedReports.value = s;
    }

    // 页面切换时绘图 + 同步 pathname
    watch(page, async (newPage) => {
      // 更新地址栏
      pushURL(newPage, newPage === 'reports' ? rType.value : '', newPage === 'reports' ? rDate.value : '');
      if (newPage === 'overview') {
        await nextTick();
        await drawOverviewCharts();
        drawSparklines();
      }
      if (newPage === 'metrics') {
        if (!metricKeys.value.length) await fetchMetricKeys();
        await loadAllMetricCharts();
      }
      if (newPage === 'reports') {
        await fetchReportTypes();
      }
    });

    // mDays 变化时重新加载所有图
    watch(mDays, async () => {
      if (page.value === 'metrics') {
        await loadAllMetricCharts();
      }
    });

    // ── popstate：浏览器前进/后退时同步状态 ──────────────────────────────────
    function applyURL() {
      const { pg, type, date } = parseURL();
      page.value = pg;
      if (pg === 'reports' && type) {
        // 如果 rType 已匹配则只切日期，否则重新加载
        if (rType.value === type && date && date !== rDate.value) {
          selectReportDate(date, true);
        } else if (rType.value !== type) {
          // 先设 rType 再异步加载，传 skipHash=true 避免再次写 hash
          rType.value = type;
          selectReportType(type, true).then(() => {
            if (date && date !== rDate.value) selectReportDate(date, true);
          });
        }
      }
    }
    function navTo(pg) {
      pushURL(pg, pg === 'reports' ? rType.value : '', pg === 'reports' ? rDate.value : '');
      page.value = pg;
    }
    window.addEventListener('hashchange', applyURL);

    // ── 初始化 & 轮询 ────────────────────────────────────────────────────────
    onMounted(async () => {
      await Promise.all([fetchStats(), fetchCron(), fetchLatestMetrics()]);
      await nextTick();

      // overview 图表（初始化时总是绘制，v-show 不会销毁 canvas）
      await drawOverviewCharts();
      drawSparklines();

      // 指标页：提前加载 metricKeys，v-show 下 canvas 已存在
      await fetchMetricKeys();
      // 用 setTimeout 确保所有 canvas 完成布局后再渲染
      setTimeout(() => loadAllMetricCharts(), 100);

      // 根据初始 hash 决定首屏（不再需要重复加载数据，只需跳到对应页面）
      if (_init.pg === 'overview') {
        // 已在上面渲染
      } else if (_init.pg === 'metrics') {
        // 已在上面初始化
      } else if (_init.pg === 'reports') {
        await fetchReportTypes();
        // fetchReportTypes 内部会 selectReportType -> selectReportDate 自动加载第一条
        // 若 hash 里有指定 type/date，等 fetchReportTypes 完成后再精确跳转
        if (_init.type && rType.value !== _init.type) {
          await selectReportType(_init.type, true);
        }
        if (_init.date && rDate.value !== _init.date) {
          await selectReportDate(_init.date, true);
        }
      } else if (_init.pg === 'cron') {
        // cron 页无特殊初始化
      } else {
        await drawOverviewCharts();
        drawSparklines();
      }

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
        window.removeEventListener('hashchange', applyURL);
      });
    });

    return {
      page, navTo, currentTime, dateStr,
      stats, statCards, cronJobs, cronActive, cronTotal,
      metricKeys, mDays,
      reportTypes, reportDates, rType, rDate, reportHtml,
      expandedReports,
      shortName, scheduleStr, statusText, statusClass, relativeTime, fmtTime,
      navigateToMetric, loadAllMetricCharts, toggleReport,
      selectReportType, selectReportDate,
    };
  },
});

app.mount('#app');
