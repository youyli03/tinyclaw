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

// 执行耗时格式化:<1s → "x.xs", <60s → "xs", <3600s → "xm xs", 否则 "xh xm"
function fmtDuration(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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
    const VALID_PAGES = ['overview', 'metrics', 'token', 'notes', 'cron'];
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

    // ── 移动端抽屉式导航 ─────────────────────────────────────────────────────
    // 手机端不再用底部 tab bar（新增 tab 会挤爆），改为顶栏 ☰ 打开侧边抽屉：
    // 导航项仍然只有 index.html 里那一处，**以后加 tab 只需加一行 nav-item**。
    const sidebarOpen = ref(false);
    // 构建号（服务端注入 <html data-build>）：显示在侧边栏页脚，用来判断手机上跑的是不是新版本
    const buildTag = ref(String(document.documentElement.dataset.build ?? "dev").slice(-6));
    const PAGE_TITLES = {
      overview: '概览', metrics: '指标', token: 'Token', notes: '笔记', cron: 'Cron 任务',
    };
    const pageTitle = computed(() => PAGE_TITLES[page.value] ?? 'tinyclaw');
    function openSidebar() { sidebarOpen.value = true; }
    function closeSidebar() { sidebarOpen.value = false; }
    function toggleSidebar() { sidebarOpen.value = !sidebarOpen.value; }
    /** 侧边栏/抽屉里点导航：切页 + 关抽屉（桌面端关不关都无感） */
    function goPage(pg) {
      page.value = pg;
      closeSidebar();
    }
    // 抽屉打开时锁住页面滚动，关闭后恢复
    watch(sidebarOpen, (open) => {
      document.body.style.overflow = open ? 'hidden' : '';
    });
    // Esc 关闭抽屉（桌面端无副作用）
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebarOpen.value) closeSidebar();
    });

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
      const deepseekVal = latestMetricVal.value['deepseek/balance'] ?? '—';
      // ⚠️ token 指标的 key 是 `llm/token/<src>/<type>`，且每行是**每轮增量**：
      // 今日用量 = 各 (来源 × 类型) 的窗口合计之和。曾经这里读的是不存在的
      // `llm/tokens_chat`，导致概览页的 Token 卡片**永远不渲染**。
      const tokenSrcs = ['chat', 'code', 'cron', 'summarizer', 'vision'];
      const tokenTypes = ['input', 'output', 'cache'];
      const tokenBySrc = {};
      let llmTokenTotal = 0;
      for (const src of tokenSrcs) {
        let s = 0;
        for (const t of tokenTypes) s += Number(latestMetricSum.value[`llm/token/${src}/${t}`] || 0);
        tokenBySrc[src] = s;
        llmTokenTotal += s;
      }
      const tokenBreakdown = tokenSrcs
        .filter((src) => tokenBySrc[src] > 0)
        .map((src) => `${src} ${Math.round(tokenBySrc[src]).toLocaleString()}`)
        .join(' · ');

      return [
        {
          key: 'electric', label: '电费余额',
          value: elecVal !== '—' ? `¥ ${Number(elecVal).toFixed(2)}` : '¥ —',
          sub1: '单位：人民币元', sub2: '点击查看趋势 →',
          color: C.accent, spark: latestSpark.value['electric/balance'] || [],
          metricKey: 'electric/balance',
        },
        {
          key: 'deepseek', label: 'DeepSeek',
          value: deepseekVal !== '—' ? `¥ ${Number(deepseekVal).toFixed(2)}` : '¥ —',
          sub1: '余额(元)', sub2: '点击查看趋势 →',
          color: C.accent2, spark: latestSpark.value['deepseek/balance'] || [],
          metricKey: 'deepseek/balance',
        },
        ...(llmTokenTotal > 0 ? [{
          key: 'llm_tokens', label: 'Token 用量',
          value: '+' + Math.round(llmTokenTotal).toLocaleString(),
          sub1: '今日 input+output+cache 合计',
          sub2: tokenBreakdown || '点击查看趋势 →',
          color: C.purple, spark: latestSpark.value['llm/token/chat/input'] || [],
          metricKey: 'llm/token/chat/input',
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
    // 窗口内合计（token 类指标是"每轮增量"，统计今日用量要累加，不是取最后一条）
    const latestMetricSum = ref({});

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

    // 一次请求取回**所有**指标的最新值/序列/合计。
    // 原实现是 /api/metric-keys + 逐 key 串行 /api/metrics（20 个 key = 21 次往返，
    // 手机上数秒），服务端现在用一条 SQL 批量返回。
    async function fetchLatestMetrics() {
      try {
        const data = await fetch('/api/metrics/latest?days=1&today=1').then(r => r.json());
        const vals = {}, sparks = {}, sums = {};
        for (const e of (data.keys || [])) {
          const k = `${e.category}/${e.key}`;
          vals[k] = e.value;
          sparks[k] = e.spark || [];
          sums[k] = e.sum ?? 0;
        }
        latestMetricVal.value = vals;
        latestSpark.value = sparks;
        latestMetricSum.value = sums;
      } catch (e) { console.warn('fetchLatestMetrics failed', e); }
    }

    // ── 图表绘制 ─────────────────────────────────────────────────────────────
    // 记录 overview 各图最后一条数据 ts(用于增量刷新)
    const overviewLastTs = {};
    // 概览 token 柱状图的**行缓存**：增量轮询只拿到新增行，但按天聚合要全量，
    // 所以把行累积在内存里（按 ts 去重），每次都能从缓存重画整张图。
    const overviewLlmRows = {}; // `${src}/${type}` → rows[]

    async function drawOverviewCharts(incremental = false) {
      const sources = ['chat', 'code', 'cron', 'summarizer'];
      const types   = ['input', 'output', 'cache'];
      // 一次请求取回 12 条 llm token 曲线 + 电费/DeepSeek 余额 + 系统快照（原来 15 次往返，
      // 而且每 30s 轮询都要再来一轮；服务端在 /api/metrics/batch 里逐条查同一个 SQLite）
      const spec = [
        ...sources.flatMap(src => types.map(t => `llm/token/${src}/${t}:7`)),
        'electric/balance:1', 'deepseek/balance:1', 'system:1',
      ].join(',');
      // 增量：取各组上次最后 ts 的**最小值**，保证没有一组会漏行（取最大值会丢数据）
      const floors = incremental
        ? [overviewLastTs.llmToken, overviewLastTs.electric, overviewLastTs.deepseek, overviewLastTs.system]
            .filter(v => v != null)
        : [];
      const since = floors.length ? Math.min(...floors) : null;
      const url = `/api/metrics/batch?spec=${encodeURIComponent(spec)}` + (since != null ? '&since=' + since : '');

      let series;
      try {
        series = (await fetch(url).then(r => r.json())).series || {};
      } catch (e) { console.warn('overview batch fetch failed', e); return; }
      const rowsOf = (id) => series[id]?.rows || [];
      const elecData = { rows: rowsOf('electric/balance') };
      const deepseekData = { rows: rowsOf('deepseek/balance') };
      const systemData = { rows: rowsOf('system') };
      // 重组: llmData[source][type] = { rows }（行累积进缓存，供按天聚合重画）
      const llmData = {};
      sources.forEach(src => {
        llmData[src] = {};
        types.forEach(t => {
          const id = `${src}/${t}`;
          const incoming = rowsOf(`llm/token/${src}/${t}`);
          if (!overviewLlmRows[id]) {
            overviewLlmRows[id] = incoming.slice();
          } else if (incoming.length) {
            const seen = new Set(overviewLlmRows[id].map(r => r.ts));
            let added = false;
            for (const r of incoming) if (!seen.has(r.ts)) { overviewLlmRows[id].push(r); added = true; }
            if (added) overviewLlmRows[id].sort((a, b) => a.ts - b.ts);
          }
          llmData[src][t] = { rows: overviewLlmRows[id] };
        });
      });

      // 电费图(今日趋势)
      try {
        const rows = (elecData.rows || []);
        const floor = overviewLastTs.electric ?? 0;
        // 批量请求用的是各组 ts 的**最小值**，所以本组可能带回已画过的点 → 按各自的 floor 去重
        const fresh = incremental ? rows.filter(r => r.ts > floor) : rows;
        if (rows.length) overviewLastTs.electric = rows[rows.length-1].ts;
        const chart = charts['chart-electric'];
        if (incremental && chart && fresh.length) {
          for (const r of fresh) chart.data.datasets[0].data.push({ x: r.ts*1000, y: r.value });
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

      // DeepSeek 余额趋势
      try {
        const rows = (deepseekData.rows || []);
        const floor = overviewLastTs.deepseek ?? 0;
        const fresh = incremental ? rows.filter(r => r.ts > floor) : rows;
        if (rows.length) overviewLastTs.deepseek = rows[rows.length-1].ts;
        const chart2 = charts['chart-deepseek'];
        if (incremental && chart2 && fresh.length) {
          for (const r of fresh) chart2.data.datasets[0].data.push({ x: r.ts*1000, y: r.value });
          chart2.update('none');
        } else if (!incremental) {
          const points = rows.map(r => ({ x: r.ts * 1000, y: r.value }));
          const canvas2 = document.getElementById('chart-deepseek');
          if (canvas2) {
            const ctx2 = canvas2.getContext('2d');
            const grad2 = ctx2.createLinearGradient(0, 0, 0, 200);
            grad2.addColorStop(0, C.accent2 + '30');
            grad2.addColorStop(1, C.accent2 + '00');
            createOrUpdateChart('chart-deepseek', {
              type: 'line',
              data: { datasets: [{ label: 'DeepSeek 余额(¥)', data: points, borderColor: C.accent2, borderWidth: 2, backgroundColor: grad2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5 }] },
              options: { ...baseChartOpts(), scales: { x: smartXAxis(1), y: { ...baseChartOpts().scales.y } } },
            });
          }
        }
      } catch (e) { console.warn('deepseek chart failed', e); }

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
        // 只在首次（非增量）时控制 card 显隐；增量时保持当前状态
        if (!incremental) {
          const llmCard = document.getElementById('llm-token-card');
          if (llmCard) llmCard.style.display = allLlmRows.length > 0 ? '' : 'none';
        }

        // 每个来源 3 种颜色（input实/output中/cache浅）
        // 统一天蓝渐变色：input(深·底) → output(中) → cache(浅·顶) 三级分层
        const tokenPalette = ['#2979ff', '#5c9dff', '#a8cdff'];  // 深→中→浅
        const sourceColors = {
          chat:       tokenPalette,
          code:       tokenPalette,
          cron:       tokenPalette,
          summarizer: tokenPalette,
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

        // 固定过去7天作为完整 labels（无数据的填0），保证比例均匀
        const today = new Date(); today.setHours(0,0,0,0);
        const fullDays = Array.from({length: 7}, (_, i) => {
          const d = new Date(today); d.setDate(d.getDate() - (6 - i));
          return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        });
        // 合并：保留 fullDays，同时加入超出7天的历史数据日期
        const displayDays = [...new Set([...allDays.filter(dk => !fullDays.includes(dk)), ...fullDays])].sort();
        // 数据来自累积缓存 → **每次都能整张重画**（原来增量轮询时这段被 !incremental 挡住，
        // 等于每 30s 抓回 12 条曲线又丢掉，柱状图一直不更新）
        if (displayDays.length) {
          const tokenCanvas = document.getElementById('chart-llm-tokens');
          if (tokenCanvas) {
            const datasets = [];
            sources.forEach((src, si) => {
              types.forEach((t, ti) => {
                const data = displayDays.map(dk => byDayMap[`${src}/${t}`][dk] || 0);
                if (data.every(v => v === 0)) return;
                datasets.push({
                  label: `${src} ${typeLabel[t]}`,
                  data: displayDays.map((dk, i) => ({ x: dk, y: data[i] })),
                  backgroundColor: sourceColors[src][ti],
                  stack: src,
                  barPercentage: 0.6,
                  categoryPercentage: 0.7,
                  borderRadius: t === 'cache' ? { topLeft: 3, topRight: 3 } : 0,
                  borderSkipped: false,
                });
              });
            });
            createOrUpdateChart('chart-llm-tokens', {
              type: 'bar',
              data: { labels: displayDays, datasets },
              options: { ...baseChartOpts(), scales: {
                x: { type: 'category', stacked: true, grid: { display: false }, border: { color: C.border }, ticks: { color: C.t3, maxRotation: 0 } },
                y: { ...baseChartOpts().scales.y, stacked: true },
              }},
            });
          }
        }
      } catch (e) { console.warn('llm token chart failed', e); }

      // 系统 CPU/内存
      try {
        const rows = systemData.rows || [];
        const floor = overviewLastTs.system ?? 0;
        const fresh = incremental ? rows.filter(r => r.ts > floor) : rows;
        if (rows.length) overviewLastTs.system = rows[rows.length-1].ts;
        const sysChart = charts['chart-system'];
        if (incremental && sysChart && fresh.length) {
          for (const r of fresh) {
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

    // 把 metricKeys 重组为展示卡片:
    //  - llm 下 token/{src}/{input|output|cache} 按后端 src 归组,每后端合并成一张堆叠柱状图
    //  - 其余 key 各自一张(保持原样)
    const LLM_TOKEN_RE = /^token\/(.+)\/(input|output|cache)$/;
    const metricCards = computed(() => {
      const cards = [];
      const seenSrc = new Set();
      for (const k of metricKeys.value) {
        const m = k.category === 'llm' ? LLM_TOKEN_RE.exec(k.key) : null;
        if (m) {
          const src = m[1];
          if (seenSrc.has(src)) continue;
          seenSrc.add(src);
          cards.push({ kind: 'llmtoken', src, id: `chart-m-llmtoken-${src}` });
        } else {
          cards.push({ kind: 'single', category: k.category, key: k.key, chart_type: k.chart_type || 'line', id: `chart-m-${k.category}-${k.key}` });
        }
      }
      return cards;
    });

    // 从概览卡片跳转到指标页
    async function navigateToMetric(categoryKey) {
      await fetchMetricKeys();
      mDays.value = '1';
      page.value = 'metrics';
      await nextTick();
      await renderMetricCards(false);
    }

    // 加载所有指标图(普通指标各一张;llm token 按后端合并一张堆叠柱状图)
    async function loadAllMetricCharts() {
      await renderMetricCards(false);
    }

    // 遍历 metricCards,按 kind 分派渲染
    async function renderMetricCards(incremental) {
      const cards = metricCards.value;
      if (!cards.length) return;
      for (const c of cards) {
        if (c.kind === 'llmtoken') {
          await loadLlmTokenCard(c.src, incremental);
        } else {
          await loadOneMetricChart(c.category, c.key, incremental, c.chart_type);
        }
      }
    }

    // 记录每个指标图最后一条数据的 ts（Unix 秒），用于增量请求
    const metricLastTs = {};

    // ── llm token 合并卡片：某后端的 input/output/cache 三级堆叠柱状图 ──────────
    async function loadLlmTokenCard(src, incremental = false) {
      try {
        const chartId = `chart-m-llmtoken-${src}`;
        const types = ['input', 'output', 'cache'];
        // 深→浅蓝：input(底/深) → output(中) → cache(顶/浅)
        const palette = { input: '#2979ff', output: '#5c9dff', cache: '#a8cdff' };
        const days = Number(mDays.value) || 1;

        const ckBase = `llmtoken/${src}`;
        const lastTs = metricLastTs[ckBase];
        const existChart = charts[chartId];
        const useIncremental = incremental && lastTs != null && existChart != null;

        const sinceParam = useIncremental ? `&since=${lastTs}` : '';
        const fetches = types.map(t =>
          fetch(`/api/metrics?category=llm&key=${encodeURIComponent('token/'+src+'/'+t)}&days=${days}${days <= 1 ? '&today=1' : ''}${sinceParam}`)
            .then(r => r.json()).catch(() => ({ rows: [] }))
        );
        const results = await Promise.all(fetches);
        const rowsByType = {};
        types.forEach((t, i) => { rowsByType[t] = results[i].rows || []; });

        function getBucketLabel(tsSec) {
          const d = new Date(tsSec * 1000);
          if (days <= 1) return String(d.getHours()).padStart(2,'0') + ':00';
          return (d.getMonth()+1) + '/' + d.getDate();
        }
        let labels;
        if (days <= 1) {
          labels = [];
          for (let h = 4; h < 24; h++) labels.push(String(h).padStart(2,'0') + ':00');
          for (let h = 0; h < 4; h++) labels.push(String(h).padStart(2,'0') + ':00');
        } else {
          const set = new Set();
          types.forEach(t => rowsByType[t].forEach(r => set.add(getBucketLabel(r.ts))));
          labels = [...set].sort((a,b) => {
            const [am,ad]=a.split('/').map(Number), [bm,bd]=b.split('/').map(Number);
            return am!==bm ? am-bm : ad-bd;
          });
        }

        if (useIncremental) {
          const chart = existChart;
          let maxTs = lastTs;
          types.forEach((t, ti) => {
            const ds = chart.data.datasets[ti];
            if (!ds) return;
            for (const r of rowsByType[t]) {
              const label = getBucketLabel(r.ts);
              const idx = chart.data.labels.indexOf(label);
              if (idx >= 0) ds.data[idx] = (ds.data[idx] || 0) + r.value;
              if (r.ts > maxTs) maxTs = r.ts;
            }
          });
          metricLastTs[ckBase] = maxTs;
          chart.update('none');
          return;
        }

        const datasets = types.map(t => {
          const bucket = new Map();
          for (const r of rowsByType[t]) {
            const label = getBucketLabel(r.ts);
            bucket.set(label, (bucket.get(label) || 0) + r.value);
          }
          return {
            label: t,
            data: labels.map(l => bucket.get(l) || 0),
            backgroundColor: palette[t],
            stack: src,
            borderRadius: t === 'cache' ? { topLeft: 3, topRight: 3 } : 0,
            borderSkipped: false,
            barPercentage: 0.7,
            categoryPercentage: 0.8,
          };
        });

        const allTs = types.flatMap(t => rowsByType[t].map(r => r.ts));
        if (allTs.length) metricLastTs[ckBase] = Math.max(...allTs);

        createOrUpdateChart(chartId, {
          type: 'bar',
          data: { labels, datasets },
          options: {
            ...baseChartOpts(),
            plugins: {
              ...baseChartOpts().plugins,
              legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, padding: 8, color: C.t3, font: { size: 10 } } },
              tooltip: { ...baseChartOpts().plugins.tooltip, callbacks: {
                title(items) { return items.length ? items[0].label : ''; },
                label(item) { return `  ${item.dataset.label}：${item.parsed.y}`; },
              }},
            },
            scales: {
              x: { stacked: true, grid: { display: false }, border: { color: C.border }, ticks: { color: C.t3, maxRotation: days <= 1 ? 45 : 0, font: { size: 11 } } },
              y: { ...baseChartOpts().scales.y, stacked: true },
            },
          },
        });
      } catch (e) { console.warn(`loadLlmTokenCard ${src} failed`, e); }
    }


    async function loadOneMetricChart(category, key, incremental = false, chartType = 'line') {
      try {
        const chartId = `chart-m-${category}-${key}`;
        const ck = `${category}/${key}`;
        const lastTs = metricLastTs[ck];

        const existChart = charts[chartId];
        const useIncremental = incremental && lastTs != null && existChart != null;
        console.log('[metric]', ck, 'incremental:', incremental, 'lastTs:', lastTs, 'existChart:', !!existChart, 'useIncremental:', useIncremental);
        const _mdays = Number(mDays.value) || 1;
        let url = `/api/metrics?category=${category}&key=${key}&days=${_mdays}${_mdays <= 1 ? '&today=1' : ''}`;
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
    // ── Token 页：prompt 构成细分 ────────────────────────────────────────────
    // 口径（对齐 DSH dsh-token-meter）：构成是**启发式估算**（chars/3.5，见
    // src/memory/token-estimate.ts），总量一律用提供方报告的 prompt_tokens；
    // 两者并排显示就是为了让偏差可见，不要拿构成当账单。
    const TOKEN_COLORS = {
      system:       '#4F7EF8',
      instructions: '#AF87FF',
      memory:       '#34C785',
      summary:      '#FF9F0A',
      tools_schema: '#0891B2',
      tool_results: '#FF6961',
      conversation: '#8B5CF6',
    };
    const TOKEN_LABELS = {
      system: '系统提示',
      instructions: '工作区指令',
      memory: '记忆注入',
      summary: '压缩摘要',
      tools_schema: '工具定义',
      tool_results: '工具结果',
      conversation: '对话正文',
    };
    const TOKEN_ORDER = ['system', 'instructions', 'memory', 'summary', 'tools_schema', 'tool_results', 'conversation'];
    // 消耗来源的中文标签（与 src/memory/token-estimate.ts 的 TOKEN_SOURCE_LABELS 对应）
    const TOKEN_SOURCE_LABELS = {
      chat: '对话', code: 'Code 模式', cron: '定时任务', loop: 'Loop 触发',
      slave: '子 Agent', skill: 'Skill 子 Agent', summarizer: '压缩/蒸馏', vision: '图片识别',
    };
    function tokenColor(cat) { return TOKEN_COLORS[cat] || '#B0B8D4'; }
    function tokenLabel(cat) { return TOKEN_LABELS[cat] || cat; }
    function tokenSourceLabel(src) { return TOKEN_SOURCE_LABELS[src] || src; }

    const tokenDays = ref('7');
    const tokenData = ref(null);
    const tokenLatest = computed(() => (tokenData.value && tokenData.value.latest) || null);
    // 构成类图/表用它：跳过只有总量（无构成）的 summarizer/vision 行
    const tokenBreakdown = computed(
      () =>
        (tokenData.value && (tokenData.value.latestBreakdown || tokenData.value.latest)) || null
    );

    function fmtNum(n) {
      return Number(n || 0).toLocaleString('zh-CN');
    }
    function pctOf(a, b) {
      const total = Number(b || 0);
      if (!total) return '—';
      return ((Number(a || 0) / total) * 100).toFixed(1) + '%';
    }
    function shortSession(id) {
      if (!id) return '—';
      return id.length > 24 ? '…' + id.slice(-22) : id;
    }

    const tokenStatCards = computed(() => {
      const d = tokenData.value;
      const t = (d && d.totals) || { rounds: 0, prompt: 0, output: 0, cacheRead: 0, cacheWrite: 0, estTotal: 0 };
      const latest = tokenLatest.value;
      const cacheRate = t.prompt > 0 ? (t.cacheRead / t.prompt) * 100 : 0;
      const ctxPct = latest && latest.contextWindow && latest.prompt
        ? (Number(latest.prompt) / latest.contextWindow) * 100
        : null;
      const estBias = t.prompt > 0 ? ((t.estTotal - t.prompt) / t.prompt) * 100 : null;
      return [
        {
          key: 'rounds', label: '请求轮数', value: fmtNum(t.rounds),
          sub1: `近 ${tokenDays.value} 日 · 每轮一行`,
          sub2: d && d.bySession ? `${d.bySession.length} 个会话` : '—',
          color: C.accent,
        },
        {
          key: 'prompt', label: 'prompt tokens（实际）', value: fmtNum(t.prompt),
          sub1: `估算构成合计 ${fmtNum(t.estTotal)}`,
          sub2: estBias == null ? '—' : `估算偏差 ${estBias > 0 ? '+' : ''}${estBias.toFixed(1)}%`,
          color: C.purple,
        },
        {
          key: 'output', label: 'output tokens', value: fmtNum(t.output),
          sub1: `缓存命中 ${cacheRate.toFixed(1)}%（read ${fmtNum(t.cacheRead)}）`,
          sub2: `cache write ${fmtNum(t.cacheWrite)}`,
          color: C.green,
        },
        {
          key: 'ctx', label: '最近一次请求占用窗口', value: ctxPct == null ? '—' : ctxPct.toFixed(1) + '%',
          sub1: latest && latest.contextWindow
            ? `实际 prompt ${fmtNum(latest.prompt)} / 窗口 ${fmtNum(latest.contextWindow)}`
            : '—',
          sub2: latest
            ? `第 ${latest.round + 1} 轮 · 会话正文估算 ${fmtNum(latest.sessionTokens || 0)} · ${relativeTime(latest.ts)}`
            : '—',
          color: C.orange,
        },
      ];
    });

    async function loadTokenPage() {
      try {
        const days = Number(tokenDays.value) || 7;
        const res = await fetch(`/api/token-breakdown?days=${days}&limit=800`).then(r => r.json());
        tokenData.value = res;
        await nextTick();
        renderTokenCharts();
      } catch (e) {
        console.warn('token page failed', e);
      }
    }

    function renderTokenCharts() {
      const d = tokenData.value;
      if (!d) return;

      // 1) 最近一次**带构成**的请求（环形）；只有总量（压缩/视觉）的行不参与
      const latest = tokenBreakdown.value;
      if (latest && latest.items.length) {
        createOrUpdateChart('chart-token-donut', {
          type: 'doughnut',
          data: {
            labels: latest.items.map(i => tokenLabel(i.category)),
            datasets: [{
              data: latest.items.map(i => i.tokens),
              backgroundColor: latest.items.map(i => tokenColor(i.category)),
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '58%',
            plugins: {
              legend: { display: true, position: 'right', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: C.t3 } },
              tooltip: {
                callbacks: {
                  label: (it) => ` ${it.label}：${fmtNum(it.parsed)} (${pctOf(it.parsed, latest.estTotal)})`,
                },
              },
            },
          },
        });
      }

      // 2) 分类堆叠趋势（按天）
      const byDay = d.byDay || [];
      if (byDay.length) {
        const seen = new Set();
        for (const day of byDay) for (const k of Object.keys(day.categories || {})) seen.add(k);
        const cats = [...seen].sort((a, b) => {
          const ia = TOKEN_ORDER.indexOf(a); const ib = TOKEN_ORDER.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        createOrUpdateChart('chart-token-byday', {
          type: 'bar',
          data: {
            labels: byDay.map(x => x.day.slice(5)),
            datasets: cats.map(c => ({
              label: tokenLabel(c),
              data: byDay.map(x => (x.categories || {})[c] || 0),
              backgroundColor: tokenColor(c),
              borderRadius: 3,
              stack: 'token',
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: C.t3 } },
              tooltip: {
                backgroundColor: '#fff', borderColor: C.border, borderWidth: 1,
                titleColor: '#1C1C2E', bodyColor: '#636380', padding: 10,
                callbacks: {
                  title: (items) => (items.length ? String(items[0].label) : ''),
                  label: (it) => ` ${it.dataset.label}：${fmtNum(it.parsed.y)}`,
                },
              },
            },
            scales: {
              x: { stacked: true, grid: { display: false }, border: { color: C.border }, ticks: { color: C.t3 } },
              y: { stacked: true, grid: { color: C.border, lineWidth: 0.8 }, border: { dash: [4, 4], color: 'transparent' }, ticks: { color: C.t3 } },
            },
          },
        });
      }

      // 3) 逐轮 prompt tokens（按时间正序；虚线为同轮估算构成，用于看偏差）
      const rows = [...(d.rows || [])].sort((a, b) => a.ts - b.ts);
      if (rows.length) {
        createOrUpdateChart('chart-token-rounds', {
          type: 'line',
          data: {
            labels: rows.map(r => fmtTime(r.ts)),
            datasets: [
              {
                label: '实际 prompt',
                data: rows.map(r => r.prompt),
                borderColor: C.accent,
                backgroundColor: C.accent + '22',
                fill: true,
                tension: 0.25,
                pointRadius: 2,
              },
              {
                label: '估算构成',
                data: rows.map(r => r.estTotal),
                borderColor: C.orange,
                borderDash: [4, 4],
                fill: false,
                tension: 0.25,
                pointRadius: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: C.t3 } },
              tooltip: {
                backgroundColor: '#fff', borderColor: C.border, borderWidth: 1,
                titleColor: '#1C1C2E', bodyColor: '#636380', padding: 10,
                callbacks: {
                  title: (items) => {
                    if (!items.length) return '';
                    const row = rows[items[0].dataIndex];
                    return `${items[0].label} · ${row ? tokenSourceLabel(row.source) : ''}`;
                  },
                  label: (it) => ` ${it.dataset.label}：${fmtNum(it.parsed.y)}`,
                },
              },
            },
            scales: {
              x: { grid: { display: false }, border: { color: C.border }, ticks: { color: C.t3, maxTicksLimit: 10, maxRotation: 0 } },
              y: { grid: { color: C.border, lineWidth: 0.8 }, border: { dash: [4, 4], color: 'transparent' }, ticks: { color: C.t3 } },
            },
          },
        });
      }
    }

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

    /**
     * 懒加载一个外部脚本（只加载一次）。
     * 用途：marked.min.js（35KB raw / 11KB gzip）**只有笔记页渲染 Markdown 才用**，
     * 原来在 index.html 里对所有页面无条件加载；现在按需加载，失败时回退 <pre>。
     */
    const loadedScripts = {};
    function loadScriptOnce(src) {
      if (loadedScripts[src]) return loadedScripts[src];
      loadedScripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve(true);
        s.onerror = () => { loadedScripts[src] = null; reject(new Error('load failed: ' + src)); };
        document.head.appendChild(s);
      });
      return loadedScripts[src];
    }

    async function openNotesFile(filePath, fileName) {
      notesSelectedPath.value = filePath;
      notesSelectedName.value = fileName || filePath.split('/').pop();
      notesPath.value = filePath;
      notesMarkdownHtml.value = '';
      notesPdfUrl.value = '';
      notesLoading.value = true;
      // 手机 PDF 走 renderPdfMobile（异步、自己管理 notesLoading）：
      // 这里**不能**在 finally 里把它按下去，否则"还在下 pdfjs + 拉 PDF"的十几秒里
      // preview 面板会掉进空状态（"点击左侧文件预览"），看起来就是"PDF 渲染坏了"。
      let mobilePdfOwnsLoading = false;
      try {
        const ext = filePath.toLowerCase().split('.').pop();
        if (ext === 'pdf') {
          if (isMobile.value) {
            notesPdfUrl.value = '';
            mobilePdfOwnsLoading = true;
            void renderPdfMobile(filePath);
          } else {
            notesPdfUrl.value = `/api/notes/file?path=${encodeURIComponent(filePath)}`;
          }
        } else {
          const data = await fetch(`/api/notes/file?path=${encodeURIComponent(filePath)}`).then(r => r.json());
          const md = data.content || '';
          // marked 懒加载：第一次打开 Markdown 笔记时才下（失败/超时就用 <pre> 原文兜底）
          if (!window.marked) {
            try { await loadScriptOnce('/marked.min.js'); } catch { /* 回退 <pre> */ }
          }
          notesMarkdownHtml.value = window.marked ? window.marked.parse(md) : `<pre>${md}</pre>`;
        }
      } catch (e) {
        notesMarkdownHtml.value = '<p style="color:var(--red)">加载失败</p>';
      } finally {
        if (!mobilePdfOwnsLoading) notesLoading.value = false;
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
    /** PDF 下载百分比（0-100）。手机上下 2MB 级 PDF 要十几秒，没有数字用户会以为坏了 */
    const pdfLoadPct = ref(0);
    // ⚠️ 移动端判定必须与 CSS 用**同一个**媒体查询：桌面端/手机端浏览器在
    // `window.innerWidth` 与 `matchMedia` 上可能给出不同结果（已在安卓 Edge 上踩到：
    // CSS 认为窄屏（顶栏样式生效）而 innerWidth > 768 → JS 把顶栏 v-if 掉了）。
    const mqMobile = window.matchMedia("(max-width: 768px)");
    const isMobile = ref(mqMobile.matches);

    // ── 诊断横幅（?diag=1）：手机端排查"顶栏/抽屉不生效"这类问题 ────────────────
    const diagEnabled = new URLSearchParams(location.search).has("diag");
    const diag = ref(null);
    function refreshDiag() {
      if (!diagEnabled) return;
      const vv = window.visualViewport;
      diag.value = {
        build: String(document.documentElement.dataset.build ?? "dev"),
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
        vw: vv ? Math.round(vv.width) : "-",
        vh: vv ? Math.round(vv.height) : "-",
        isMobile: isMobile.value,
        mq: mqMobile.matches,
        topbar: !!document.querySelector(".mobile-topbar"),
        ua: navigator.userAgent,
      };
    }
    // 视口变化：以媒体查询的 change 事件为准（与 CSS 同步），resize 只作兜底刷新诊断
    mqMobile.addEventListener("change", (e) => {
      isMobile.value = e.matches;
      refreshDiag();
      if (!e.matches && sidebarOpen.value) closeSidebar();
    });
    window.addEventListener('resize', () => {
      refreshDiag();
      // 切回桌面宽度时收掉抽屉，避免残留遮罩挡住页面
      if (!isMobile.value && sidebarOpen.value) closeSidebar();
    });
    function notesMobileBack() {
      notesMobileView.value = 'tree';
      notesFullscreen.value = false;
    }

    async function renderPdfMobile(filePath) {
      const url = `/api/notes/file?path=${encodeURIComponent(filePath)}`;
      // ⚠️ 第一步就必须把 pdfPages 置为 loading：模板的 v-else-if 链只有
      //    `isMobile && pdfPages.length` 命中时才会渲染 PDF 容器，否则用户在
      //    "下 pdfjs + 拉整个 PDF"的十几秒里看到的是"点击左侧文件预览"。
      pdfPages.value = ['loading'];
      pdfProgress.value = { cur: 0, total: 0 };
      pdfLoadPct.value = 0;
      notesLoading.value = true;
      try {
        const pdfjsLib = await import('/pdfjs/pdf.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
        const pdf = await pdfjsLib.getDocument({
          url,
          // 下载进度（服务端带 Content-Length，pdf.js 会回调 loaded/total）
          onProgress: (p) => {
            if (p && p.total) pdfLoadPct.value = Math.min(99, Math.round((p.loaded / p.total) * 100));
          },
        }).promise;
        pdfLoadPct.value = 100;
        notesLoading.value = false;
        const total = pdf.numPages;
        pdfProgress.value = { cur: 0, total };
        await Vue.nextTick();
        const container = document.querySelector('.notes-pdf-mobile-pages');
        if (!container) {
          // 以前这里静默 return（页面既不显示错误也不显示内容）
          throw new Error('预览容器未就绪');
        }
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

        // canvas 像素宽度 = **容器 CSS 宽度 × min(dpr,2)**。
        // 原来直接用 scale=min(dpr,2)：手机上 dpr=3 → scale 2 → 612pt 的页面变成
        // 1224×1584 px（约 7.7MB 一块 canvas），而实际只按 ~380px 宽显示 —— 画得慢、
        // 内存大，Android 上更容易被浏览器节流/杀。按显示宽度算既清晰又省一半以上。
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = container.clientWidth || window.innerWidth || 360;

        const rendered = new Set();
        const renderPage = async (pageNum, ph) => {
          if (rendered.has(pageNum)) return;
          rendered.add(pageNum);
          const page = await pdf.getPage(pageNum);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.max(0.5, (cssWidth / base.width) * pixelRatio);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
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
        // 失败必须给出**出路**：手机浏览器自带 PDF 阅读器，点链接直接看原文件
        notesMarkdownHtml.value =
          '<p style="color:var(--red)">PDF 渲染失败: ' +
          (e && e.message ? e.message : e) +
          '</p><p><a href="' + url + '" target="_blank" rel="noopener">用系统阅读器打开 →</a></p>';
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
        const mInited = metricCards.value.some(c =>
          c.kind === 'llmtoken'
            ? metricLastTs[`llmtoken/${c.src}`] != null
            : metricLastTs[`${c.category}/${c.key}`] != null
        );
        await renderMetricCards(mInited);
      }
      if (newPage === 'token') {
        await nextTick();
        await loadTokenPage();
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

    /** 每 30s 的一次刷新：按当前页取数，再画该页的图 */
    async function refreshTick() {
      // 后台标签页不轮询：手机上省电/省流量（回到前台时立即补一次，见 visibilitychange）
      if (document.hidden) return;
      const pg = page.value;
      if (pg === 'overview') {
        await Promise.all([fetchStats(), fetchCron(), fetchLatestMetrics()]);
        await drawOverviewCharts(true); // 增量刷新
        drawSparklines();
      } else if (pg === 'cron') {
        await fetchCron();
      } else if (pg === 'metrics' && metricKeys.value.length) {
        await renderMetricCards(true); // 增量
      } else if (pg === 'token') {
        await loadTokenPage();
      }
    }

    /**
     * 进入某页时按需拉数据（首次进入才拉；切回已加载过的页不重复请求）。
     * 这样首屏只付"当前页"的代价，切页也快。
     */
    async function ensurePageLoaded(pg) {
      if (pg === 'overview') {
        // ⚠️ 概览图**必须在前台绘制**：canvas 在 display:none 容器里尺寸是 0，隐藏时画的就是废图
        if (!stats.value) await fetchStats();
        if (!cronJobs.value.length) await fetchCron();
        if (!Object.keys(latestMetricVal.value).length) await fetchLatestMetrics();
        await drawOverviewCharts();
        drawSparklines();
      } else if (pg === 'metrics') {
        // 绘图依赖 key 列表（key 列表也决定卡片分组）
        if (!metricKeys.value.length) await fetchMetricKeys();
        await loadAllMetricCharts(); // display:block，可以安全绘图
      } else if (pg === 'notes') {
        // 深链（/notes?path=…）：**先开预览**再拉目录树。PDF 要下 pdfjs + 整份文件（手机十几秒），
        // 串行等目录树会让用户先盯着"点击左侧文件预览"好几秒，像坏了一样。
        const openP =
          _init.notesFile && !notesSelectedPath.value
            ? openNotesFile(_init.notesFile, _init.notesFile.split('/').pop())
            : Promise.resolve();
        const treeP = notesTree.value.length ? Promise.resolve() : fetchNotesTree();
        await Promise.all([openP, treeP]);
      } else if (pg === 'cron') {
        if (!cronJobs.value.length) await fetchCron();
      } else if (pg === 'token') {
        await loadTokenPage();
      }
    }

    onMounted(async () => {
      // 先采集一次诊断（此时顶栏应已在 DOM 里），再按当前页拉数据
      await nextTick();
      refreshDiag();
      await ensurePageLoaded(_init.pg);

      // 切页 / 浏览器前进后退都会改 page → 按需补该页数据
      watch(page, (pg) => { void ensurePageLoaded(pg); });

      // 每 30 秒刷新（后台标签页暂停，见 refreshTick）
      const refreshTimer = setInterval(() => void refreshTick(), 30000);
      const onVisibility = () => {
        if (!document.hidden) void refreshTick();
      };
      document.addEventListener('visibilitychange', onVisibility);

      onUnmounted(() => {
        clearInterval(refreshTimer);
        clearInterval(timeTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        Object.values(charts).forEach(c => c.destroy());
        window.removeEventListener('popstate', applyURL);
      });
    });

    return {
      page, navTo, currentTime, dateStr,
      sidebarOpen, pageTitle, openSidebar, closeSidebar, toggleSidebar, goPage, buildTag, diag,
      stats, statCards, cronJobs, cronActive, cronTotal,
      metricKeys, metricCards, mDays,
      tokenDays, tokenData, tokenLatest, tokenBreakdown, tokenStatCards, loadTokenPage,
      fmtNum, pctOf, shortSession, tokenColor, tokenSourceLabel,
      expandedReports,
      shortName, scheduleStr, statusText, statusClass, relativeTime, fmtTime, fmtDuration,
      navigateToMetric, loadAllMetricCharts, toggleReport,
      notesTree, notesSelectedPath, notesSelectedName, notesPath, notesMarkdownHtml,
      notesPdfUrl, notesLoading, notesFullscreen, notesQuery, notesSearchResults, notesExpandedPaths,
      notesMobileView, notesMobileBack, isMobile, pdfPages, pdfProgress, pdfLoadPct,
      fetchNotesTree, openNotesFile, onTreeDirOpen, onNotesSearch, clearNotesSearch, openNotesFolder,
    };
  },
});

app.component('notes-tree-node', NotesTreeNode);
app.mount('#app');
