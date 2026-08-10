# Sivan’s Studio 第一版

这一版已经把学生、教师、班级、文章、打卡和朗读提交迁移到服务端 SQLite 数据库，并使用服务端签发的 HttpOnly 会话 Cookie。访问令牌有效期为 30 分钟。

## 启动

需要 Node.js 22.5 或更高版本：

```powershell
$env:SIVAN_TOKEN_SECRET = "replace-with-a-long-random-secret"
$env:SIVAN_TEACHER_USERNAME = "sivan.teacher"
$env:SIVAN_TEACHER_PASSWORD = "replace-with-a-teacher-password"
node server.mjs
```

PDF处理和图片型页面 OCR 还需要 Python 3，以及：

```powershell
python -m pip install -r requirements.txt
```

如果需要指定Python位置，可设置 `SIVAN_PYTHON`。

当前常驻服务地址为 `http://127.0.0.1:8766/`。也可以通过环境变量修改端口：

```powershell
$env:SIVAN_PORT = "8766"
node server.mjs
```

## 初始账号

首次使用空数据库启动时，必须通过环境变量提供教师用户名和强密码。项目不再内置可登录的教师或学生测试密码。

启动后由教师端添加学生并设置 code。教师密码和学生 code 均以 scrypt 哈希保存在数据库中，不应提交 `.env` 或 `data/`。

## 第一版范围

- 服务端验证学生和教师身份。
- 30 分钟签名会话，不把令牌写入 `localStorage`。
- 删除或更新学生后旧会话立即失效。
- 学生只能看到自己班级分配的文章。
- 教师可累积选择并上传多个 PDF；上传前显示附件数量、文件名和大小，并可单独移除。
- 读物按上传顺序自动归入 `Booklist 1 / 2 / 3...`，每个书单最多 10 本，教师端可切换书单管理。
- PDF 逐页渲染为 JPEG 图片并保留原文件；有文字层时直接提取，没有文字层时自动 OCR。
- 教师读物库仅显示第一页作为封面预览，并显示总页数和已识别文字的页数。
- 教师按班级勾选可选读物，学生在本班范围内自由选择今日读物。
- PDF 按页面拆分，识别出的文字按标点自动拆成句子。
- 学生页面只显示当前句，不显示整页大段文字。
- 每句话必须录音后才能确认，前端和后端都限制最长 60 秒。
- 录音保存在服务端 `data/recordings`，教师可以回听历史录音。
- 服务端使用词序列对齐计算当前演示分数。
- 教师首页按班级显示当天每名学生是否参与、所读文章和当天分数。
- 学生日历中已完成日期为绿色，已到但未完成日期为红色，未来日期保持灰色。
- 学生完成阅读后可以在成绩页逐句回听自己的录音；当天也可以从首页再次展开回听。
- 数据库保存真实得分；教师端显示真实得分。学生端显示鼓励分，计算规则为 `max(真实得分, 7.5)`。

发音评分目前仍是浏览器转写匹配。接入 Azure Pronunciation Assessment 后，才能把它升级为音素级发音准确度评分。
