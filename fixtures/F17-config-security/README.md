# F17 config-security

**测什么**：恶意 TS 配置、项目生命周期脚本、恶意命令与未授权配置。

**断言**：

- 未授权 `.ts` 配置返回 E18，且不执行配置内的写文件代码。
- 授权后：项目外读写、网络、子进程均被拒绝；主流程以 E17 报告，不产生标记文件。
- `prepare` / `postinstall` / `build` 脚本在 init/build 中不执行。
- `commands.allow` 中的 `rm` / `git clean` 被 E17 拒绝。

**Golden 来源**：测试断言副作用不存在（标记文件、网络连接、脚本产物），不是工具自证。
