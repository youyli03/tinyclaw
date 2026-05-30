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
    const VALID_PAGES = ['overview', 'metrics', 'notes', 'cron'];
    function parseURL() {
      const parts = location.pathname.replace(/^\//, '').split('/');
      const pg = VALID_PAGES.includes(parts[0]) ? parts[0] : 'overview';
      const sp = new URLSearchParams(location.search);
      const notesFile = sp.get('path') || '';
      return { pg, notesFile };
    }
    function pushURL(pg, notesFilePath) {
      let p = '/' + pg;
      let search = '';
      if (pg === 'notes' && notesFilePath) {
        search = '?path=' + encodeURIComponent(notesFilePath);
      }
      if (location.pathname !== p || location.search !== search)
        history.pushState({}, '', p + search);
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
      const llmTokenChat = latestMetricVal.value['llm/tokens_chat'] ?? 0;
      const llmTokenCode = latestMetricVal.value['llm/tokens_code'] ?? 0;
      const llmTokenCron = latestMetricVal.value['llm/tokens_cron'] ?? 0;
      const llmTokenSumm = latestMetricVal.value['llm/tokens_summarizer'] ?? 0;
      const llmTokenTotal = llmTokenChat + llmTokenCode + llmTokenCron + llmTokenSumm;
      const llmTokenVal = llmTokenTotal > 0 ? llmTokenTotal : '—';

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
        ...(llmTokenVal !== '—' && Number(llmTokenVal) > 0 ? [{
          key: 'llm_tokens', label: 'Token 用量',
          value: (() => {
            // 显示今日增量（最新值 - 今日最早值）
            return llmTokenVal !== '—' ? '+' + Math.round(Number(llmTokenVal)).toLocaleString() : '—';
          })(),
          sub1: '今日 output tokens 增量', sub2: '点击查看趋势 →',
          color: C.purple, spark: latestSpark.value['llm/tokens_chat'] || [],
          metricKey: 'llm/tokens_chat',
        }] : []),
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
          const data = await fetch(`/api/metrics?category=${category}&key=${key}&days=1`).then(r => r.json());
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
    // 记录 overview 各图最后一条数据 ts(用于增量刷新)
    const overviewLastTs = {};

    async function drawOverviewCharts(incremental = false) {
      // 并行拉取数据源
      const sinceToken = incremental && overviewLastTs.llmToken != null ? '&since=' + overviewLastTs.llmToken : '';
      const elecUrl    = '/api/metrics?category=electric&key=balance&days=1'  + (incremental && overviewLastTs.electric != null ? '&since=' + overviewLastTs.electric : '');
      const copilotUrl = '/api/metrics?category=copilot&key=remaining&days=1' + (incremental && overviewLastTs.copilot  != null ? '&since=' + overviewLastTs.copilot  : '');
      const systemUrl  = '/api/metrics?category=system&days=1'                + (incremental && overviewLastTs.system   != null ? '&since=' + overviewLastTs.system   : '');
      const sources = ['chat', 'code', 'cron', 'summarizer'];
      const types   = ['input', 'output', 'cache'];
      // 每个来源3个 key，共12个请求
      const llmFetches = sources.flatMap(src =>
        types.map(t => fetch(`/api/metrics?category=llm&key=${encodeURIComponent('token/'+src+'/'+t)}&days=7${sinceToken}`).then(r => r.json()).catch(() => ({ rows: [] })))
      );
      let elecData, copilotData, systemData;
      let llmRawData; // flat array: [chat/input, chat/output, chat/cache, code/input, ...]
      try {
        [elecData, copilotData, systemData, ...llmRawData] = await Promise.all([
          fetch(elecUrl).then(r => r.json()),
          fetch(copilotUrl).then(r => r.json()),
          fetch(systemUrl).then(r => r.json()),
          ...llmFetches,
        ]);
      } catch (e) { console.warn('overview parallel fetch failed', e); return; }
      // 重组: llmData[source][type] = { rows }
      const llmData = {};
      sources.forEach((src, si) => {
        llmData[src] = {};
        types.forEach((t, ti) => { llmData[src][t] = llmRawData[si * types.length + ti]; });
      });

      // 电费图(今日趋势)
      try {
        const rows = (elecData.rows || []);
        if (rows.length) overviewLastTs.electric = rows[rows.length-1].ts;
        const chart = charts['chart-electric'];
        if (incremental && chart && rows.length) {
          for (const r of rows) chart.data.datasets[0].data.push({ x: r.ts*1000, y: r.value });
          chart.update('none');
        } else if (!incremental) {
          const points = rows.map(r => ({ x: r.ts * 1000, y: r.value }));
          const canvas = document.getElementById('chart-electric');
          if (canvas) {
            const ctx = canvas.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 200);
            grad.addColorStop(0, C.accent + '30');
            grad.addColorStop(1, C.accent + '00');
            createOrUpdateChart('chart-electric', {
              type: 'line',
              data: { datasets: [{ label: '电费余额(元)', data: points, borderColor: C.accent, borderWidth: 2, backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 }] },
              options: { ...baseChartOpts(), scales: { x: smartXAxis(1), y: { ...baseChartOpts().scales.y } } },
            });
          }
        }
      } catch (e) { console.warn('electric chart failed', e); }

      // 高级请求剩余趋势
      try {
        const rows = (copilotData.rows || []).filter(r => r.value >= 0);
        if (rows.length) overviewLastTs.copilot = rows[rows.length-1].ts;
        const chart2 = charts['chart-copilot'];
        if (incremental && chart2 && rows.length) {
          for (const r of rows) chart2.data.datasets[0].data.push({ x: r.ts*1000, y: r.value });
          chart2.update('none');
        } else if (!incremental) {
          const points = rows.map(r => ({ x: r.ts * 1000, y: r.value }));
          const canvas2 = document.getElementById('chart-copilot');
          if (canvas2) {
            const ctx2 = canvas2.getContext('2d');
            const grad2 = ctx2.createLinearGradient(0, 0, 0, 200);
            grad2.addColorStop(0, C.accent2 + '30');
            grad2.addColorStop(1, C.accent2 + '00');
            createOrUpdateChart('chart-copilot', {
              type: 'line',
              data: { datasets: [{ label: '高级请求剩余', data: points, borderColor: C.accent2, borderWidth: 2, backgroundColor: grad2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5 }] },
              options: { ...baseChartOpts(), scales: { x: smartXAxis(1), y: { ...baseChartOpts().scales.y } } },
            });
          }
        }
      } catch (e) { console.warn('copilot chart failed', e); }

      // LLM Token 用量 — 堆叠柱状图，每来源3种颜色(input/output/cache)
      try {
        const toDateKey = (ts) => {
          const d = new Date(ts * 1000);
          return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        };
        const aggregateByDay = (rows) => {
          const map = {};
          for (const r of (rows || [])) { const dk = toDateKey(r.ts); map[dk] = (map[dk] || 0) + (r.value || 0); }
          return map;
        };

        // 收集所有行来确定最新 ts 和 hasAny
        const allLlmRows = sources.flatMap(src => types.flatMap(t => llmData[src][t]?.rows || []));
        if (allLlmRows.length) overviewLastTs.llmToken = Math.max(...allLlmRows.map(r => r.ts));
        const hasAny = allLlmRows.length > 0;
        const llmCard = document.getElementById('llm-token-card');
        if (llmCard) llmCard.style.display = hasAny ? '' : 'none';

        // 每个来源 3 种颜色（深/中/浅）
        const sourceColors = {
          chat:       ['#a78bfacc', '#7c3aedcc', '#5b21b6cc'],  // 紫色系 input/output/cache
          code:       ['#60a5facc', '#2563ebcc', '#1e3a8acc'],  // 蓝色系
          cron:       ['#fb923ccc', '#ea580ccc', '#9a3412cc'],  // 橙色系
          summarizer: ['#4ade80cc', '#16a34acc', '#14532dcc'],  // 绿色系
        };
        const typeLabel = { input: 'in', output: 'out', cache: 'cache' };

        // 聚合所有 source+type 的按天数据
        const byDayMap = {};  // key = "src/type" → {dk: value}
        sources.forEach(src => types.forEach(t => {
          byDayMap[`${src}/${t}`] = aggregateByDay(llmData[src][t]?.rows || []);
        }));

        const allDays = [...new Set(
          Object.values(byDayMap).flatMap(m => Object.keys(m))
        )].sort();

        if (!incremental && allDays.length) {
          const tokenCanvas = document.getElementById('chart-llm-tokens');
          if (tokenCanvas) {
            const datasets = [];
            sources.forEach((src, si) => {
              types.forEach((t, ti) => {
                const data = allDays.map(dk => byDayMap[`${src}/${t}`][dk] || 0);
                if (data.every(v => v === 0)) return; // 跳过全零系列
                datasets.push({
                  label: `${src} ${typeLabel[t]}`,
                  data: allDays.map((dk, i) => ({ x: dk, y: data[i] })),
                  backgroundColor: sourceColors[src][ti],
                  stack: src,  // 同来源叠加，不同来源并排
                });
              });
            });
            createOrUpdateChart('chart-llm-tokens', {
              type: 'bar',
              data: { labels: allDays, datasets },
              options: { ...baseChartOpts(), scales: {
                x: { ...smartXAxis(7), stacked: true },
                y: { ...baseChartOpts().scales.y, stacked: true },
              }},
            });
          }
        }
      } catch (e) { console.warn('llm token chart failed', e); }

      // 系统 CPU/内存
      try {
        const rows = systemData.rows || [];
        if (rows.length) overviewLastTs.system = rows[rows.length-1].ts;
        const sysChart = charts['chart-system'];
        if (incremental && sysChart && rows.length) {
          for (const r of rows) {
            sysChart.data.datasets[0].data.push({ x: r.ts*1000, y: r.cpu_percent });
            sysChart.data.datasets[1].data.push({ x: r.ts*1000, y: Math.round(r.mem_used_mb / r.mem_total_mb * 100) });
          }
          sysChart.update('none');
        } else if (!incremental) {
          const cpuPoints = rows.map(r => ({ x: r.ts * 1000, y: r.cpu_percent }));
          const memPoints = rows.map(r => ({ x: r.ts * 1000, y: Math.round(r.mem_used_mb / r.mem_total_mb * 100) }));
          const canvas = document.getElementById('chart-system');
          if (canvas) {
            const ctx = canvas.getContext('2d');
            const gradCpu = ctx.createLinearGradient(0, 0, 0, 240); gradCpu.addColorStop(0, C.accent + '25'); gradCpu.addColorStop(1, C.accent + '00');
            const gradMem = ctx.createLinearGradient(0, 0, 0, 240); gradMem.addColorStop(0, C.green + '25'); gradMem.addColorStop(1, C.green + '00');
            createOrUpdateChart('chart-system', {
              type: 'line',
              data: { datasets: [
                { label: 'CPU %',  data: cpuPoints, borderColor: C.accent, borderWidth: 1.8, backgroundColor: gradCpu, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 },
                { label: '内存 %', data: memPoints, borderColor: C.green,  borderWidth: 1.8, backgroundColor: gradMem, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 },
              ]},
              options: { ...baseChartOpts(), scales: { x: smartXAxis(1), y: { ...baseChartOpts().scales.y, min: 0, max: 100 } } },
            });
          }
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
    const mDays = ref('1');

    async function fetchMetricKeys() {
      try {
        const data = await fetch('/api/metric-keys').then(r => r.json());
        metricKeys.value = data.keys || [];
      } catch (e) { console.warn('fetchMetricKeys failed', e); }
    }

    // 从概览卡片跳转到指标页
    async function navigateToMetric(categoryKey) {
      await fetchMetricKeys();
      mDays.value = '1';
      page.value = 'metrics';
      await nextTick();
      const nmInited = metricKeys.value.some(k => metricLastTs[k.category + '/' + k.key] != null);
      for (const k of metricKeys.value) {
        await loadOneMetricChart(k.category, k.key, nmInited, k.chart_type || 'line');
      }
    }

    // 加载所有指标图（每个指标独立一张图）
    async function loadAllMetricCharts() {
      if (!metricKeys.value.length) return;
      for (const k of metricKeys.value) {
        await loadOneMetricChart(k.category, k.key, false, k.chart_type || 'line');
      }
    }

    // 记录每个指标图最后一条数据的 ts（Unix 秒），用于增量请求
    const metricLastTs = {};

    async function loadOneMetricChart(category, key, incremental = false, chartType = 'line') {
      try {
        const chartId = `chart-m-${category}-${key}`;
        const ck = `${category}/${key}`;
        const lastTs = metricLastTs[ck];

        const existChart = charts[chartId];
        const useIncremental = incremental && lastTs != null && existChart != null;
        console.log('[metric]', ck, 'incremental:', incremental, 'lastTs:', lastTs, 'existChart:', !!existChart, 'useIncremental:', useIncremental);
        let url = `/api/metrics?category=${category}&key=${key}&days=${mDays.value}`;
        if (useIncremental) url += `&since=${lastTs}`;

        const data = await fetch(url).then(r => r.json());
        const rows = data.rows || [];

        if (useIncremental) {
          // 增量：只 push 新数据进已有图表
          if (rows.length > 0) {
            const chart = existChart;
            const ds = chart.data.datasets[0];
            for (const r of rows) ds.data.push({ x: r.ts * 1000, y: r.value });
            metricLastTs[ck] = rows[rows.length - 1].ts;
            chart.update('none');
          }
          return;
        }


        // 全量:重建图表
        const canvas = document.getElementById(chartId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        if (chartType === 'bar') {
          // ── 柱状图:按时间分桶聚合 ────────────────────────────────────────
          const days = Number(mDays.value) || 1;

          function getBucketLabel(tsSec) {
            const d = new Date(tsSec * 1000);
            if (days <= 1) {
              return String(d.getHours()).padStart(2,'0') + ':00';
            }
            return (d.getMonth()+1) + '/' + d.getDate();
          }

          const bucketMap = new Map();
          for (const r of rows) {
            const label = getBucketLabel(r.ts);
            bucketMap.set(label, (bucketMap.get(label) || 0) + r.value);
          }

          let labels;
          if (days <= 1) {
            labels = [];
            for (let h = 4; h < 24; h++) labels.push(String(h).padStart(2,'0') + ':00');
            for (let h = 0; h < 4; h++) labels.push(String(h).padStart(2,'0') + ':00');
          } else {
            labels = [...bucketMap.keys()].sort((a,b) => {
              const [am, ad] = a.split('/').map(Number);
              const [bm, bd] = b.split('/').map(Number);
              return am !== bm ? am - bm : ad - bd;
            });
          }

          createOrUpdateChart(chartId, {
            type: 'bar',
            data: {
              labels,
              datasets: [{
                label: ck,
                data: labels.map(l => bucketMap.get(l) || 0),
                backgroundColor: C.accent + '99',
                borderColor: C.accent,
                borderWidth: 1,
                borderRadius: 3,
              }],
            },
            options: {
              ...baseChartOpts(),
              scales: {
                x: {
                  grid: { display: false },
                  border: { color: C.border },
                  ticks: { color: C.t3, maxRotation: days <= 1 ? 45 : 0, font: { size: 11 } },
                },
                y: { ...baseChartOpts().scales.y },
              },
            },
          });
        } else {
          // ── 折线图:原有逻辑 ──────────────────────────────────────────────
          const h = canvas.clientHeight || 180;
          const grad = ctx.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, C.accent + '30');
          grad.addColorStop(1, C.accent + '00');
          createOrUpdateChart(chartId, {
            type: 'line',
            data: {
              datasets: [{
                label: ck,
                data: rows.map(r => ({ x: r.ts * 1000, y: r.value })),
                borderColor: C.accent,
                borderWidth: 1.5,
                backgroundColor: grad,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 4,
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
        }
        if (rows.length > 0) metricLastTs[ck] = rows[rows.length - 1].ts;

      } catch (e) { console.warn(`loadOneMetricChart ${category}/${key} failed`, e); }
    }

    // ── 日报页（已废弃，保留空占位避免引用报错） ─────────────────────────────
    const reportTypes = ref([]);
    const reportDates = ref([]);
    const rType = ref('');
    const rDate = ref('');
    const reportHtml = ref('');
    async function fetchReportTypes() {}
    async function selectReportType() {}
    async function selectReportDate() {}

    // ── 笔记页 ───────────────────────────────────────────────────────────────
    const notesTree = ref([]);
    const notesSelectedPath = ref('');
    const notesSelectedName = ref('');
    const notesPath = ref('');            // 面包屑显示当前路径
    const notesMarkdownHtml = ref('');
    const notesPdfUrl = ref('');
    const notesLoading = ref(false);
    const notesFullscreen = ref(false);
    const notesQuery = ref('');
    const notesSearchResults = ref(null); // null = 未搜索
    const notesExpandedPaths = ref(new Set()); // 搜索展开时强制展开的目录集合
    let notesSearchTimer = null;

    async function fetchNotesTree() {
      try {
        const data = await fetch('/api/notes/tree').then(r => r.json());
        notesTree.value = data.tree || [];
      } catch (e) { console.warn('fetchNotesTree failed', e); }
    }

    async function openNotesFile(filePath, fileName) {
      notesSelectedPath.value = filePath;
      notesSelectedName.value = fileName || filePath.split('/').pop();
      notesPath.value = filePath;
      notesMarkdownHtml.value = '';
      notesPdfUrl.value = '';
      notesLoading.value = true;
      // 全屏时关闭树
      try {
        const ext = filePath.toLowerCase().split('.').pop();
        if (ext === 'pdf') {
          if (isMobile.value) {
            notesPdfUrl.value = '';
            renderPdfMobile(filePath);
          } else {
            notesPdfUrl.value = `/api/notes/file?path=${encodeURIComponent(filePath)}`;
          }
        } else {
          const data = await fetch(`/api/notes/file?path=${encodeURIComponent(filePath)}`).then(r => r.json());
          const md = data.content || '';
          notesMarkdownHtml.value = window.marked ? window.marked.parse(md) : `<pre>${md}</pre>`;
        }
      } catch (e) {
        notesMarkdownHtml.value = '<p style="color:var(--red)">加载失败</p>';
      } finally {
        notesLoading.value = false;
      }
      // 手机端切到预览视图
      notesMobileView.value = 'preview';
      // 更新浏览器 URL（保证刷新后能恢复）
      pushURL('notes', filePath);
    }

    function onTreeDirOpen(path) {
      notesPath.value = path;
    }

    function onNotesSearch() {
      clearTimeout(notesSearchTimer);
      if (!notesQuery.value.trim()) {
        notesSearchResults.value = null;
        return;
      }
      notesSearchTimer = setTimeout(async () => {
        try {
          const data = await fetch(`/api/notes/search?q=${encodeURIComponent(notesQuery.value)}`).then(r => r.json());
          notesSearchResults.value = data.results || [];
        } catch { notesSearchResults.value = []; }
      }, 350);
    }

    function clearNotesSearch() {
      notesQuery.value = '';
      notesSearchResults.value = null;
    }

    // 搜索结果点击文件夹：展开树至该节点
    function openNotesFolder(dirPath) {
      // 把该目录及所有祖先路径都加入 expandedPaths
      const parts = dirPath.split('/');
      const paths = new Set(notesExpandedPaths.value);
      for (let i = 1; i <= parts.length; i++) {
        paths.add(parts.slice(0, i).join('/'));
      }
      notesExpandedPaths.value = paths;
      // 清空搜索词，切回树视图
      notesQuery.value = '';
      notesSearchResults.value = null;
    }

    // 手机端视图状态
    const notesMobileView = ref('tree'); // 'tree' | 'preview'
    const pdfPages = ref([]); // [{canvas, pageNum}] for mobile PDF.js render
    const pdfProgress = ref({ cur: 0, total: 0 }); // 渲染进度
    const isMobile = ref(window.innerWidth <= 768);
    window.addEventListener('resize', () => { isMobile.value = window.innerWidth <= 768; });
    function notesMobileBack() {
      notesMobileView.value = 'tree';
      notesFullscreen.value = false;
    }

    async function renderPdfMobile(filePath) {
      pdfPages.value = [];
      pdfProgress.value = { cur: 0, total: 0 };
      notesLoading.value = true;
      try {
        const url = `/api/notes/file?path=${encodeURIComponent(filePath)}`;
        const pdfjsLib = await import('/pdfjs/pdf.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
        const pdf = await pdfjsLib.getDocument(url).promise;
        notesLoading.value = false;
        const total = pdf.numPages;
        pdfProgress.value = { cur: 0, total };
        pdfPages.value = ['loading'];
        await Vue.nextTick();
        const container = document.querySelector('.notes-pdf-mobile-pages');
        if (!container) return;
        container.innerHTML = '';

        // 为每页创建占位 div
        const placeholders = [];
        for (let i = 0; i < total; i++) {
          const ph = document.createElement('div');
          ph.style.width = '100%';
          ph.style.minHeight = '400px';
          ph.style.marginBottom = '6px';
          ph.dataset.page = String(i + 1);
          ph.dataset.rendered = '0';
          container.appendChild(ph);
          placeholders.push(ph);
        }

        const rendered = new Set();
        const renderPage = async (pageNum, ph) => {
          if (rendered.has(pageNum)) return;
          rendered.add(pageNum);
          const page = await pdf.getPage(pageNum);
          const scale = Math.min(window.devicePixelRatio || 2, 2);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = '100%';
          canvas.style.display = 'block';
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          ph.innerHTML = '';
          ph.style.minHeight = '';
          ph.appendChild(canvas);
          pdfProgress.value = { cur: rendered.size, total };
        };

        // 先渲染前2页
        for (let i = 0; i < Math.min(2, total); i++) {
          await renderPage(i + 1, placeholders[i]);
        }

        // IntersectionObserver 懒加载剩余页
        const obs = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const ph = entry.target;
              const pageNum = parseInt(ph.dataset.page);
              renderPage(pageNum, ph);
              obs.unobserve(ph);
            }
          });
        }, { rootMargin: '400px' });

        for (let i = 2; i < total; i++) {
          obs.observe(placeholders[i]);
        }

      } catch (e) {
        notesLoading.value = false;
        pdfPages.value = [];
        notesMarkdownHtml.value = '<p style="color:var(--red)">PDF 加载失败: ' + e.message + '</p>';
      }
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
      pushURL(newPage, '');
      if (newPage === 'overview') {
        await nextTick();
        const ovInited = Object.keys(overviewLastTs).length > 0;
        await drawOverviewCharts(ovInited);
        drawSparklines();
      }
      if (newPage === 'metrics') {
        if (!metricKeys.value.length) await fetchMetricKeys();
        await nextTick();
        const mInited = metricKeys.value.some(k => metricLastTs[k.category + '/' + k.key] != null);
        for (const k of metricKeys.value) {
          await loadOneMetricChart(k.category, k.key, mInited);
        }
      }
      if (newPage === 'notes') {
        if (!notesTree.value.length) await fetchNotesTree();
      }
    });

    // mDays 变化时全量重载（清空增量 ts 记录）
    watch(mDays, async () => {
      if (page.value === 'metrics') {
        // 清空增量记录，强制全量请求
        Object.keys(metricLastTs).forEach(k => delete metricLastTs[k]);
        await loadAllMetricCharts();
      }
    });

    // ── popstate：浏览器前进/后退时同步状态 ──────────────────────────────────
    function applyURL() {
      const { pg, notesFile } = parseURL();
      page.value = pg;
      if (pg === 'notes' && notesFile) {
        openNotesFile(notesFile, notesFile.split('/').pop());
      }
    }
    function navTo(pg) {
      pushURL(pg, '');
      page.value = pg;
    }
    window.addEventListener('popstate', applyURL);

    // ── 初始化 & 轮询 ────────────────────────────────────────────────────────
    onMounted(async () => {
      await Promise.all([fetchStats(), fetchCron(), fetchLatestMetrics()]);
      await nextTick();

      // overview 图表（初始化时总是绘制，v-show 不会销毁 canvas）
      await drawOverviewCharts();
      drawSparklines();

      // 指标页:只预取 key 列表，不绘图（display:none 时 canvas 尺寸为 0）

      await fetchMetricKeys();
      // 根据初始 hash 决定首屏（不再需要重复加载数据，只需跳到对应页面）
      if (_init.pg === 'overview') {
        // 已在上面渲染
      } else if (_init.pg === 'metrics') {
        await loadAllMetricCharts(); // display:block，可以安全绘图
      } else if (_init.pg === 'notes') {
        await fetchNotesTree();
        if (_init.notesFile) {
          await openNotesFile(_init.notesFile, _init.notesFile.split('/').pop());
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
          await drawOverviewCharts(true); // 增量刷新
          drawSparklines();
        }
        if (page.value === 'metrics' && metricKeys.value.length) {
          for (const k of metricKeys.value) {
            await loadOneMetricChart(k.category, k.key, true, k.chart_type || 'line'); // 增量
          }
        }
      }, 30000);

      onUnmounted(() => {
        clearInterval(refreshTimer);
        clearInterval(timeTimer);
        Object.values(charts).forEach(c => c.destroy());
        window.removeEventListener('popstate', applyURL);
      });
    });

    return {
      page, navTo, currentTime, dateStr,
      stats, statCards, cronJobs, cronActive, cronTotal,
      metricKeys, mDays,
      expandedReports,
      shortName, scheduleStr, statusText, statusClass, relativeTime, fmtTime,
      navigateToMetric, loadAllMetricCharts, toggleReport,
      notesTree, notesSelectedPath, notesSelectedName, notesPath, notesMarkdownHtml,
      notesPdfUrl, notesLoading, notesFullscreen, notesQuery, notesSearchResults, notesExpandedPaths,
      notesMobileView, notesMobileBack, isMobile, pdfPages, pdfProgress,
      fetchNotesTree, openNotesFile, onTreeDirOpen, onNotesSearch, clearNotesSearch, openNotesFolder,
    };
  },
});

app.component('notes-tree-node', NotesTreeNode);
app.mount('#app');
