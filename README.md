# Sivan’s Studio

Sivan’s Studio 是一个单机部署的少儿英语阅读应用。教师可管理班级与学生、批量上传 PDF、按班级分配读物并查看真实成绩和录音；学生可逐句跟读、回听录音，并通过日历查看打卡记录。

## 运行环境

- Node.js 22.5 或更高版本（使用内置 `node:sqlite`）
- Python 3
- PDF 渲染与 OCR 依赖：`python -m pip install -r requirements.txt`

首次使用空数据库启动前，请设置环境变量：

```powershell
$env:SIVAN_PORT = "8766"
$env:SIVAN_TOKEN_SECRET = "replace-with-a-long-random-secret"
$env:SIVAN_TEACHER_USERNAME = "sivan.teacher"
$env:SIVAN_TEACHER_PASSWORD = "replace-with-a-strong-teacher-password"
node server.mjs
```

默认地址为 `http://127.0.0.1:8766/`。如需指定 Python，可设置 `SIVAN_PYTHON`。可复制 `.env.example` 查看全部配置项；项目本身不会自动读取 `.env`，部署服务需要把这些变量注入进程环境。

## 当前实现

- 后端使用 Node.js，业务数据保存在 `data/sivan-studio.db`（SQLite WAL 模式）。
- PDF 原文件和逐页图片保存在 `data/pdfs/`，学生录音保存在 `data/recordings/`。
- 登录使用服务端签名的 HttpOnly Cookie，有效期 30 分钟；教师密码和学生 code 使用 scrypt 哈希保存。
- 所有打卡日、今日状态和日历统计均按 `Asia/Shanghai` 计算，不依赖服务器的 UTC 日期。
- PDF 上传接口会立即返回；渲染和 OCR 由后台单并发队列异步执行。实测单本通常约需 3 分钟，多本按上传顺序逐本处理，因此 10 本通常约需 30 分钟。状态为 `processing`、`ready` 或 `failed`，服务重启后会恢复未完成任务，失败任务可在教师端重试。为给正常耗时留出充足余量，单本处理上限可通过 `SIVAN_PDF_TIMEOUT_SECONDS` 配置，默认 900 秒；即使 Python 异常退出，只要最终 manifest 和全部页面图片完整，后端仍会恢复结果并标记为 ready。
- 每 10 本读物自动归入一个 `Booklist`。处理完成后，教师可按班级分配，学生只能看到本班已分配且处理完成的读物。
- 学生逐句录音，每句最长 60 秒；完成后学生和教师都可逐句回听。
- 数据库存储真实成绩，教师端显示真实成绩；学生端显示 `max(真实成绩, 7.5)`。

目前的发音判断仍基于浏览器语音转写结果与目标文本的词序列对齐，并非音素级发音评估。若要判断重音、音素或流利度，应再接入 Azure Pronunciation Assessment 等专用服务。

## 数据与备份

`data/` 已被 `.gitignore` 排除，不应提交到 GitHub。迁移或备份服务器时，应停止应用后整体复制 `data/`，以同时保留数据库、PDF、页面图片和录音。更完整的结构、异步处理流程及数据库选型说明见 `BACKEND_AUTH_ARCHITECTURE.md`。

## 批量书库导入

大量 PDF/PNG 不需要通过浏览器逐本选择。`scripts/upload_library.mjs` 可通过端口转发后的教师 API 顺序上传、自动续传并防止重复建书；`scripts/reset_library.mjs` 用于备份后的生产环境离线清库。清库会保留账号，但会删除书籍、成绩、打卡和录音。完整命令、安全条件和恢复方式见 `Ops.md` 的“清空书库并从本地批量上传”。
