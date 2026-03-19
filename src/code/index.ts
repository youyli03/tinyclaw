/**
 * src/code 模块入口
 *
 * 副作用 import：`import "../code/index.js"` 即完成所有注册。
 * 在 src/commands/builtin.ts 中导入一次（模块缓存保证幂等）。
 */

import "./commands.js";
