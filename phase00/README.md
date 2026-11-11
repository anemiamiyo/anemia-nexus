# Phase 00 验证原型与夹具

本目录是 Anemia Nexus Phase 00 的**验证原型**，不是 Phase 01 的产品实现。原型代码只用于证明技术路线与门槛，不得直接复制为生产模块。

## 目录

| 路径        | 说明                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `lib/`      | 断言可复用的最小能力：SCIP 解析、TS 声明、Vue 虚拟代码、身份迁移、SQLite 协议、mini-index、配置安全 |
| `g1-g3/`    | G1 SCIP↔TS 映射、G2 Vue 语义/模板边、G3 重导出/合并/跨包                                            |
| `g4/`       | G4 身份迁移八场景                                                                                   |
| `g5/`       | G5 SQLite 提交协议七注入点 + 崩溃恢复                                                               |
| `g6/`       | G6 Node 22.16.0 / 24.22.2 双版本                                                                    |
| `g7/`       | G7 5 万 / 30 万 LOC RSS 测量（百万行档按负责人批准跳过）                                            |
| `g8/`       | G8 五级降级、取消、失败隔离                                                                         |
| `g9/`       | G9 配置安全七用例 + E18                                                                             |
| `g10/`      | G10 全量 vs 增量十字段等价                                                                          |
| `mcp/`      | 官方 SDK v2 stdio 协议探针                                                                          |
| `security/` | 恶意配置、网络阻断、CJS/ESM 阻断钩子                                                                |
| `results/`  | 每次运行产生的 JSON 证据（入库）                                                                    |
| `tmp/`      | 生成项目与临时仓库（git 忽略）                                                                      |

## 运行

```bash
npm run phase00          # 全部 11 项
node phase00/g1-g3/run-g1.mjs
# ...其余单项见 docs/phase-00/02-validation-report.md
```

多数验证需要 Node 子进程权限（npm、SCIP、vue-tsc、git、MCP、受限配置），在受限沙箱中需一次性放宽。

## 结论

见 `docs/phase-00/02-validation-report.md`：11/11 通过，其中 G2/G5/G7/G8/G9/G10 为 `pass-with-limit`，限制均已记录。**Phase 01 未启动。**
