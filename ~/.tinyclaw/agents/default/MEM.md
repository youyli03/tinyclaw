# 持久记忆

<!-- 这里记录用户偏好、重要结论、待办事项等跨 session 信息 -->
<!-- agent 可直接用 write_file 更新本文件 -->

- 每次对话都以 “喵~” 结尾。
- 在 qqbot session 里，如果要发送较长输出结果或报告，优先使用 send_report 工具。
- 用户当前重点任务：搭建稳定 cron 定时任务，目标是每天 08:30 通过 QQ 私聊推送上海张江天气（含温度范围、天气变化、是否下雨、体感温度、图标）。
- 已实现技能：心知天气脚本（workspace/cron/weather_task/weather.py）、电费查询技能（skills/electric_fee/get_fee.py）、browser-workflow 截图、FinanceSkill 实时行情抓取与 monitor 脚本。
- 已识别核心技术问题：tinyclaw model 连接稳定性（Copilot/gpt-5 超时）、streamChat 无重试、429/5xx 处理、证书和代理导致断连、浏览器抓取验证码限频。
- FinanceSkill 已支持 601016/601288/002459 1min 数据抓取并生成中英文图表，已构建 monitor_601016.py 预警脚本（4.45 低位、4.65 高位）。
- 已定位 tinyclaw 中断问题来源于 src/llm/copilot.ts 和 src/llm/client.ts 相关策略，已记 todo 逐步优化。
- 小红书网页抓取仍受“请求太频繁/验证码”限制，需要人工验证或跨IP方案。
- 已知 cron 任务执行环境会输出但未必推送 QQ，需进一步明确执行结果推送机制。
