# Polymarket 自动交易 + 自动学习迭代系统设计

> 设计日期：2026-03-20
> 状态：架构设计阶段

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                 Polymarket Auto-Trading System                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Data Layer  │─▶│ Signal Layer │─▶│  Execution Layer      │ │
│  │  (采集/存储)  │  │  (预测/决策)  │  │  (下单/风控)           │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│          │                │                      │              │
│          └────────────────▼──────────────────────┘              │
│                    ┌──────────────┐                              │
│                    │ Learn Layer  │                              │
│                    │ (评估/迭代)   │                              │
│                    └──────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四层架构详解

### 1. Data Layer — 数据采集与存储

**数据源：**

| 来源 | 内容 |
|------|------|
| Polymarket CLOB API | 市场价格、订单簿、成交量、流动性 |
| Polymarket Gamma API | 市场元数据、事件分类、结算结果 |
| News APIs (GDELT/NewsAPI) | 相关新闻、情绪分析 |
| Social (X/Reddit) | 社交情绪信号 |
| Metaculus | 外部预测参考 |

**存储：** PostgreSQL（结构化）+ Redis（实时缓存）

**核心数据结构：**

```python
# 每个市场的特征向量
MarketFeature = {
    "market_id": str,
    "yes_price": float,            # 当前 YES 价格
    "no_price": float,
    "spread": float,               # bid-ask spread
    "volume_24h": float,
    "liquidity": float,
    "time_to_resolution": int,     # 剩余天数
    "sentiment_score": float,      # 新闻情绪 [-1, 1]
    "social_buzz": float,          # 社交热度
    "resolution_prob_external": float,  # 外部参考概率
    "historical_accuracy": float,  # 该类市场历史准确率
}
```

---

### 2. Signal Layer — 预测与决策

采用**多模型集成（Ensemble）**架构：

```
┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│ Base Model 1 │  │ Base Model 2 │  │     Base Model 3     │
│  (规则系统)   │  │  (ML 模型)   │  │    (LLM 推理)         │
│  统计套利     │  │ XGBoost/RF  │  │    GPT-4 + RAG       │
└──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘
       │                 │                      │
       └─────────────────▼──────────────────────┘
                   ┌──────────────┐
                   │  Meta-Model  │  (权重动态调整)
                   │  (Stacking)  │
                   └──────┬───────┘
                          │
              Final Signal: {buy/sell/hold, confidence}
```

**三类基础模型：**

| 模型 | 策略 | 优势 |
|------|------|------|
| 规则模型 | 统计套利、价格偏差检测 | 稳定、可解释 |
| ML 模型 | XGBoost/LightGBM，特征工程 | 高效、泛化 |
| LLM 模型 | GPT-4 读新闻/事件推理 | 处理文本、边缘事件 |

---

### 3. Execution Layer — 下单与风控

```
Signal → [风控检查] → [仓位计算] → [CLOB 下单] → [监控]
```

**风控规则：**
- 单笔最大下单金额 < 总资金 × 5%
- 单市场持仓上限 < 总资金 × 20%
- 每日最大亏损熔断 10%
- 最小 confidence > 0.65 才入场
- spread > 0.05 跳过

**仓位计算（Half-Kelly Criterion）：**

```python
# Full Kelly
f_star = (p * b - q) / b   # p=预测概率, b=赔率, q=1-p

# 实际使用 Half-Kelly 降低风险
position_size = f_star / 2 * total_capital
```

---

### 4. Learn Layer — 自动学习迭代

```
① 结果收集：市场结案后，记录预测 vs 实际结果
      ↓
② 归因分析：哪个模型预测对了？什么特征最重要？
      ↓
③ 数据增量训练：新数据加入训练集，重训模型
      ↓
④ A/B 回测：新模型 vs 旧模型在历史数据上对比
      ↓
⑤ Canary 部署：新模型先用 5% 资金试跑 2 周
      ↓
⑥ 元学习器更新：根据各模型近期表现，调整 ensemble 权重

触发时机：每周自动 or 有 N 个新结案市场时
```

**Brier Score 追踪：**

```python
# 每个预测都记录 Brier Score
brier = (predicted_prob - actual_outcome) ** 2
# 越低越好（0=完美，0.25=随机）
# 按模型/按市场类型分别统计
# 某类市场上 LLM 模型 Brier 更低，自动提升其权重
```

**在线学习（Online Learning）：**

```python
# 不等周训练，每次市场结案立即更新
model.partial_fit(new_data)        # sklearn SGD 类模型支持
# LLM prompt 里加入近期错误案例作为 few-shot
```

**提示词自进化：**

- 每次预测错误的案例 → 加入 negative examples
- 每次预测正确的案例 → 加入 positive examples
- 每周更新一版 prompt，通过 A/B 测试验证

---

## 目录结构

```
polymarket-trader/
├── data/
│   ├── collectors/
│   │   ├── polymarket_clob.py      # 实时价格/订单簿
│   │   ├── polymarket_gamma.py     # 市场元数据
│   │   └── news_sentiment.py       # 新闻情绪
│   ├── storage/
│   │   ├── postgres_store.py
│   │   └── redis_cache.py
│   └── pipeline.py                 # 数据 ETL
│
├── signals/
│   ├── models/
│   │   ├── rule_based.py           # 规则/统计套利
│   │   ├── ml_model.py             # XGBoost 特征模型
│   │   └── llm_reasoner.py         # LLM 推理
│   ├── ensemble.py                 # Meta-model 集成
│   └── feature_engineering.py
│
├── execution/
│   ├── risk_manager.py             # 风控
│   ├── position_sizer.py           # Kelly 仓位
│   ├── clob_executor.py            # CLOB API 下单
│   └── portfolio_tracker.py        # 持仓监控
│
├── learning/
│   ├── outcome_collector.py        # 结果归集
│   ├── attribution.py              # 归因分析
│   ├── trainer.py                  # 增量训练
│   ├── backtester.py               # 回测评估
│   └── model_registry.py           # 模型版本管理
│
├── scheduler/
│   ├── jobs.py                     # Cron 任务定义
│   └── orchestrator.py             # 任务调度器
│
├── monitoring/
│   ├── dashboard.py                # Streamlit/Grafana
│   └── alerts.py                   # 告警推送
│
├── config/
│   ├── settings.yaml
│   └── strategy_params.yaml
│
└── main.py
```

---

## 调度任务设计（tinyclaw cron）

| 频率 | 任务 |
|------|------|
| 每 5 分钟 | 数据采集 + 信号生成 + 执行 |
| 每 1 小时 | 持仓盈亏检查 + 风控审计 |
| 每天 6:00 | 日报汇总推送（收益/亏损/胜率） |
| 每周日 | 学习迭代流程（训练/回测/更新权重） |

---

## 技术选型

| 组件 | 推荐方案 | 原因 |
|------|---------|------|
| 调度 | APScheduler / tinyclaw cron | 轻量、可靠 |
| 存储 | PostgreSQL + Redis | 结构化+高速缓存 |
| ML 模型 | XGBoost / LightGBM | 小数据集效果好 |
| LLM | GPT-4o / Claude | 文本推理强 |
| 回测 | Backtrader / 自实现 | 灵活 |
| 监控 | Streamlit / Grafana | 快速可视化 |
| 模型版本 | MLflow | 实验追踪 |

---

## 落地顺序

```
Phase 1（1-2周）：数据采集 + 只读监控，摸清市场规律
Phase 2（2-4周）：规则模型 + 小资金手动确认测试
Phase 3（1-2月）：ML 模型上线 + 全自动化执行
Phase 4（持续）：LLM 集成 + 自动学习迭代启动
```

---

## 风险提示

1. **Polymarket 仅限部分地区**，确认合规性（目前美国 IP 受限）
2. **Kelly 仓位要保守**，建议使用 Half-Kelly
3. **LLM 推理有延迟**，高频场景（<5min）不适合
4. **市场流动性薄**，大单会显著移动价格
5. **自动迭代要设熔断**，模型变差时自动回滚旧版本
6. **私钥安全**，CLOB API 需要链上签名，私钥必须离线存储
