# Sivan’s Studio 用户认证与后端建设方案

## 1. 文档目的

当前项目是只有 `index.html`、`app.js` 和 `styles.css` 的纯前端原型，学生、文章、打卡记录和录音都保存在浏览器 `localStorage` 中。这种实现适合界面演示，但无法可靠地完成账号管理、跨设备同步、学生数据隔离、删除账号后立即失效、教师收取录音、OCR 和真实发音评测。

本文给出一个可以逐步落地的后端方案。核心目标是：

- 学生使用“姓名 + 教师设置的 code”登录；学生不能自行修改 code。
- 教师拥有独立且安全性更高的账户，可以管理班级、学生、材料和录音。
- 任何学生只能访问自己的数据，以及自己所在班级被分配的阅读材料。
- 教师删除或停用学生后，学生现有会话立即失效，不能继续登录。
- 数据、原始录音和绘本文件能够跨设备保存，并支持备份和审计。
- OCR、语音转写与发音评测由服务端任务处理，不依赖某一种浏览器。

## 2. 推荐总体架构

建议先采用“模块化单体后端”，不要一开始拆成多个微服务：

```text
学生端 / 教师端
       │ HTTPS
       ▼
后端 API（Node.js + TypeScript）
       ├── 身份认证与权限检查
       ├── 学生、班级、文章、打卡 API
       ├── 录音/文件上传签名
       └── 后台任务调度
          │
          ├── PostgreSQL：结构化业务数据
          ├── 对象存储：录音、图片、PDF、DOCX
          ├── 任务队列：OCR、转写、发音评测
          └── 第三方或自建 AI 服务适配层
```

推荐组件：

- 后端：Node.js + TypeScript，使用 NestJS、Fastify 或 Express 中任意一种成熟框架。
- 数据库：PostgreSQL。
- 文件存储：兼容 S3 的私有对象存储；数据库只保存对象 key 和元数据，不保存大段 Base64。
- 后台任务：生产环境使用 Redis 队列；早期版本可以先使用数据库任务表和单独 worker。
- 部署：前端、API、worker 和数据库分开配置，但可以先部署在同一个云项目中。
- 日志监控：记录请求 ID、任务状态和错误，不在日志中记录 code、令牌或完整学生录音内容。

## 3. 身份体系与登录方案

### 3.1 角色

系统至少包含以下角色：

| 角色 | 能力 |
|---|---|
| `student` | 查看自己的首页、被分配的材料、自己的录音结果和打卡记录 |
| `teacher` | 管理自己有权限的班级、学生、材料、分配和录音 |
| `admin` | 可选；管理教师和学校，不参与日常教学 |

角色只是第一层控制。后端还必须检查资源归属，例如教师只能管理自己所属学校或被授权班级中的学生。

### 3.2 学生登录

保留当前产品要求的“学生姓名 + code”形式，但认证必须在服务端完成：

1. 教师创建学生，填写显示姓名、班级和初始 code。
2. 浏览器将姓名和 code 通过 HTTPS 发送到 `POST /api/auth/student/login`。
3. 后端按学校/租户和标准化姓名查找学生，再验证 code 哈希。
4. 验证成功后建立学生会话；响应中绝不返回 code 或 code 哈希。
5. 后续请求从会话读取 `student_id`，不能接受前端自行提交另一个学生 ID 来切换身份。

code 规则建议：

- code 至少使用 8 位数字，或者 6–10 位易读字母数字组合；不建议继续使用公开的 `1234`。
- 数据库只存储 Argon2id 哈希及其参数，不保存明文 code。
- 同一学校内建议限制“标准化姓名”唯一；如果允许重名，应额外生成一个简短登录 ID，避免学生无法区分。
- 登录接口按 IP、学校和姓名进行速率限制；连续失败后短时锁定并记录安全事件。
- 学生端不提供修改 code 的 API。教师可以重置 code，重置时撤销该学生全部旧会话。
- 登录页不得再显示演示学生姓名、code 或教师 code。

### 3.3 教师登录

教师不应使用一个全系统共享的固定 code。建议采用：

- 邮箱 + 密码；密码同样使用 Argon2id 哈希。
- 支持密码重置和邮箱验证。
- 条件允许时启用 MFA；至少教师管理员必须启用。
- 后续可接入学校 Google/Microsoft SSO，但第一版不必因此推迟上线。

### 3.4 会话设计

Web 端推荐使用短期访问会话和可撤销的刷新会话：

- 访问令牌有效期为 30 分钟，只包含用户 ID、角色、租户 ID、会话 ID 和 token version。
- 刷新令牌使用随机不透明值，只通过 `Secure`、`HttpOnly`、`SameSite` Cookie 保存。
- 数据库只保存刷新令牌哈希；每次刷新都旋转令牌，旧令牌立即失效。
- 登出、重置 code、停用或删除账号时撤销全部相关会话。
- 前端不把访问令牌、刷新令牌或学生资料写入 `localStorage`。
- 所有修改型接口校验 CSRF 防护策略；所有环境只通过 HTTPS 提供登录和上传。

### 3.5 删除学生后的行为

为保证删除操作可审计且可恢复，建议使用软删除：

1. 教师调用 `DELETE /api/students/:id`。
2. 后端验证教师对该学生所属班级的管理权限。
3. 在一个数据库事务中设置 `status = 'deleted'`、`deleted_at`，并递增 `token_version`。
4. 撤销该学生全部 `auth_sessions`。
5. 登录、刷新令牌及所有学生 API 都必须检查 `status = 'active'`。
6. 录音和成绩按学校的数据保留政策处理；需要彻底删除时由后台任务清理对象存储，并写审计记录。

这样即使学生页面仍然开着，下一次 API 请求也会得到 `401/403`，不能继续提交。

## 4. 数据库设计

建议使用 UUID 作为主键，所有业务表都包含 `created_at` 和 `updated_at`。关键表如下。

### 4.1 用户、学校和班级

```sql
organizations (
  id uuid primary key,
  name text not null
);

teachers (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  email text not null,
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('teacher', 'admin')),
  status text not null default 'active',
  token_version integer not null default 1,
  unique (organization_id, email)
);

classes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null,
  archived_at timestamptz,
  unique (organization_id, name)
);

teacher_class_access (
  teacher_id uuid references teachers(id),
  class_id uuid references classes(id),
  primary key (teacher_id, class_id)
);

students (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  class_id uuid references classes(id),
  display_name text not null,
  normalized_name text not null,
  code_hash text not null,
  status text not null default 'active',
  token_version integer not null default 1,
  deleted_at timestamptz,
  unique (organization_id, normalized_name)
);
```

如果未来一个学生需要加入多个班级，可把 `students.class_id` 替换为 `student_class_memberships` 关联表。

### 4.2 阅读材料与班级分配

```sql
reading_materials (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  title text not null,
  source_object_key text not null,
  source_type text not null,
  processing_status text not null,
  published_at timestamptz,
  created_by uuid not null references teachers(id)
);

material_articles (
  id uuid primary key,
  material_id uuid not null references reading_materials(id),
  title text not null,
  article_order integer not null
);

material_pages (
  id uuid primary key,
  article_id uuid not null references material_articles(id),
  page_order integer not null,
  image_object_key text,
  ocr_text text not null default '',
  ocr_status text not null,
  teacher_approved_at timestamptz
);

material_sentences (
  id uuid primary key,
  page_id uuid not null references material_pages(id),
  sentence_order integer not null,
  expected_text text not null
);

class_material_assignments (
  class_id uuid references classes(id),
  material_id uuid references reading_materials(id),
  assigned_by uuid not null references teachers(id),
  assigned_at timestamptz not null,
  primary key (class_id, material_id)
);
```

学生获取材料时，后端根据会话中的 `student_id → class_id` 联表过滤，不能让前端下载所有材料后再自行隐藏。

### 4.3 阅读、录音、成绩与打卡

```sql
reading_sessions (
  id uuid primary key,
  student_id uuid not null references students(id),
  material_id uuid not null references reading_materials(id),
  status text not null,
  total_words integer,
  wrong_words integer,
  score numeric(3,1),
  started_at timestamptz not null,
  submitted_at timestamptz
);

sentence_attempts (
  id uuid primary key,
  reading_session_id uuid not null references reading_sessions(id),
  sentence_id uuid not null references material_sentences(id),
  attempt_number integer not null,
  audio_object_key text not null,
  duration_ms integer not null check (duration_ms <= 60000),
  transcript text,
  assessment_json jsonb,
  wrong_word_count integer,
  status text not null
);

attendance_daily (
  student_id uuid not null references students(id),
  read_date date not null,
  completed_session_id uuid not null references reading_sessions(id),
  primary key (student_id, read_date)
);

auth_sessions (
  id uuid primary key,
  actor_type text not null,
  actor_id uuid not null,
  refresh_token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

audit_logs (
  id uuid primary key,
  organization_id uuid not null,
  actor_type text not null,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz not null
);
```

建议索引：

- `students (organization_id, normalized_name)`
- `reading_sessions (student_id, submitted_at desc)`
- `attendance_daily (student_id, read_date)`
- `material_pages (article_id, page_order)`
- `sentence_attempts (reading_session_id, sentence_id)`
- `auth_sessions (actor_type, actor_id, revoked_at)`

## 5. 权限与数据隔离

每个 API 都必须在服务端执行以下检查：

```text
请求是否已认证？
  └─ 否：401
角色是否允许执行该操作？
  └─ 否：403
目标资源是否属于当前 organization？
  └─ 否：404（避免泄露资源存在性）
教师是否拥有目标班级权限，或学生是否就是资源所有者？
  └─ 否：404/403
账号是否 active，token version 和会话是否仍有效？
  └─ 否：401
```

数据库连接必须使用参数化查询或 ORM，不能拼接 SQL。若团队熟悉 PostgreSQL Row Level Security，可以再增加数据库层的租户隔离；但 RLS 不能替代 API 层的权限测试。

必须编写自动化测试证明：

- 学生 A 不能读取学生 B 的首页、录音、成绩或打卡记录。
- Blue Class 学生不能读取只分配给 Green Class 的材料，包括直接猜 URL。
- 普通教师不能管理未授权班级。
- 已删除学生不能登录，旧访问令牌和刷新令牌也不能继续使用。
- 学生不能调用新增学生、改 code、分配材料或教师录音列表 API。

## 6. 文件上传、绘本分割与 OCR

### 6.1 上传流程

1. 教师创建上传任务，后端返回短时有效的预签名上传地址。
2. 浏览器直接把 PDF、DOCX、图片或 TXT 上传到私有对象存储。
3. 上传完成后，后端验证文件扩展名、MIME、大小和文件签名，并进行恶意文件扫描。
4. worker 将 PDF/DOCX 转成逐页图片；图片按上传顺序组成页面。
5. OCR 服务识别每页文字，保存坐标、置信度和纯文本。
6. 系统按标题、空白页和版面线索提出文章分割建议。
7. 教师在发布前确认文章边界、页序、OCR 文字和句子切分。
8. 只有状态为 `published` 且已分配给班级的材料才能被学生访问。

完全自动分割绘本容易误判，因此“机器建议 + 教师确认”比无确认自动发布更安全。

### 6.2 学生阅读页面

每次只返回当前句子的内容：

- 当前页的一幅图片。
- 当前句子，供学生朗读。
- 不在句子旁展示整页大段文字。
- 录音最长 60 秒；前端自动停止，后端再次验证实际媒体时长。
- 学生提交当前句后才进入下一句。

对象存储文件保持私有，后端只向已授权用户签发短时下载 URL。URL 到期后不能继续访问。

## 7. 发音评测与评分方案

### 7.1 不应继续使用浏览器转写结果直接评分

普通语音转文字只能大致判断“系统听到了什么词”，不能可靠判断学生是否把单词发对。建议增加一个统一的 `PronunciationAssessmentProvider` 适配层，后端可以接入具备以下输出的语音评测服务：

- 单词级准确度和错误类型。
- 音素级准确度。
- 漏读、替换和多读检测。
- 时间戳、置信度和完整转写。

如果第一阶段只能使用普通 ASR，也必须把结果标记为“转写匹配分”，不能对用户宣称为专业发音准确度。

### 7.2 错词对齐

使用动态规划进行词序列对齐，而不是按数组下标比较：

- substitution：读成另一个词，计 1 个错词。
- deletion：漏读，计 1 个错词。
- insertion：多读，可计 1 个错词，并在教师端单独展示。
- pronunciation error：词相同但音素准确度低于阈值，计 1 个错词。

同一个标准词只计一次错误，避免同时因转写和音素问题重复扣分。

### 7.3 评分公式

保持用户要求的 10 分制：

```text
wrong_ratio = min(wrong_words / expected_word_count, 1)
score = round((1 - wrong_ratio) × 10, 1)
```

例如标准文本 100 词、错 10 词：`(1 - 10 / 100) × 10 = 9.0`。

评分阈值和服务版本必须记录到 `assessment_json` 中，使同一份录音的评分可追溯。

### 7.4 学生端与教师端展示区别

最新需求要求学生读错后不要通过文字纠正，因此建议：

- 学生端：只提示“请听正确发音”，播放错词或当前句子的标准语音，不展示红色正确答案。
- 教师端：可以查看完整转写、标准文本、红色错词、错误类型和原始录音。
- 标准语音优先使用稳定的云端 TTS 生成并缓存；同一句话不必每次重新合成。

## 8. 打卡与教师端

只有完整提交一篇指定文章并生成有效成绩后，才写入当天的 `attendance_daily`。数据库唯一键保证同一天重复阅读只算一次打卡，但所有阅读记录仍可保留。

学生首页接口返回：

- 学生显示姓名。
- 指定月份的每日打卡状态；有记录为绿色，没有记录为灰色。
- 当前月打卡天数。
- 当前年打卡天数。
- 最近一次分数和当前可见材料。

教师端按班级返回：

- 班级学生列表。
- 每名学生的月/年打卡次数与具体日期。
- 每次阅读的文章、分数、错词数和提交时间。
- 每句话的录音播放地址；地址必须短时有效。

## 9. API 草案

```text
POST   /api/auth/student/login
POST   /api/auth/teacher/login
POST   /api/auth/refresh
POST   /api/auth/logout

GET    /api/me
GET    /api/student/home?month=2026-08
GET    /api/student/materials
GET    /api/student/materials/:id/sentences/:sentenceId
POST   /api/student/reading-sessions
POST   /api/student/reading-sessions/:id/attempts/upload-url
POST   /api/student/reading-sessions/:id/attempts
POST   /api/student/reading-sessions/:id/submit
GET    /api/student/reading-sessions/:id/result

GET    /api/teacher/classes
POST   /api/teacher/classes
GET    /api/teacher/classes/:id/students
POST   /api/teacher/students
PATCH  /api/teacher/students/:id
POST   /api/teacher/students/:id/reset-code
DELETE /api/teacher/students/:id
GET    /api/teacher/students/:id/attendance
GET    /api/teacher/students/:id/submissions

POST   /api/teacher/materials
POST   /api/teacher/materials/:id/upload-url
GET    /api/teacher/materials/:id/processing-status
PATCH  /api/teacher/materials/:id/pages/:pageId
POST   /api/teacher/materials/:id/publish
PUT    /api/teacher/materials/:id/class-assignments
```

创建、修改、删除、发布、分配和重置 code 的接口都需要写入 `audit_logs`。

## 10. 鼓励语生成

鼓励语不需要依赖大模型即可稳定满足格式。后端可按成绩区间从经过教师审核的句库中选择 2–3 句，避免生成不适合儿童的内容：

```text
Hi Marcus, you did a good job! Keep reading!
Every practice makes your voice clearer.
By Sivan.
```

姓名只在开头出现一次，最后固定为 `By Sivan.`。如果未来使用生成模型，也应限制模板、长度和敏感内容，并保留服务端最终格式化步骤。

## 11. 安全、隐私与运维要求

该系统涉及未成年人声音和学习记录，应至少做到：

- 明确告知监护人/学校录音用途、保存期限和删除方式。
- 数据传输全程 HTTPS，数据库和对象存储启用静态加密。
- 录音桶默认私有，不使用永久公开 URL。
- 最小权限访问；生产、测试和开发环境的数据分开。
- 对登录、删除、code 重置、材料发布和录音访问进行审计。
- 定期备份 PostgreSQL，并执行恢复演练；对象存储配置版本或生命周期策略。
- 设置录音和未完成阅读会话的自动过期策略。
- 严格限制上传文件类型和大小，执行文件扫描。
- 错误响应不返回堆栈、SQL、对象 key、哈希或第三方密钥。
- 密钥只放在部署平台的 secret 管理中，不提交到前端或 Git。

## 12. 从当前项目迁移的实施顺序

### 第一阶段：认证与核心数据

- 建立 PostgreSQL、后端 API 和数据库迁移机制。
- 完成教师账户、学生姓名 + code 登录、会话撤销和权限中间件。
- 将学生、班级、材料分配、打卡和成绩从 `localStorage` 迁移到 API。
- 删除首页演示 code 和硬编码教师 code。
- 补齐越权访问和删除后失效的集成测试。

### 第二阶段：文件与录音

- 接入私有对象存储和预签名上传。
- 服务端验证录音时长不超过 60 秒。
- 教师端可以查看所有提交并播放授权范围内的录音。
- 完成 PDF、DOCX、图片和 TXT 的处理流水线。

### 第三阶段：OCR 与发音评测

- 接入 OCR provider，增加教师校对和文章分割确认页面。
- 接入音素级发音评测 provider。
- 使用词序列对齐替换当前按位置比较算法。
- 学生端只播放语音纠正；教师端保留文字诊断。

### 第四阶段：上线保障

- 完成备份、监控、审计、速率限制和数据保留策略。
- 进行学生 A/B 隔离、班级隔离、文件越权、会话撤销和上传安全测试。
- 使用少量测试班级试运行，确认评分阈值后再扩大使用。

## 13. 最低上线验收标准

以下条件全部满足后，系统才适合真实学生使用：

- 页面源码和浏览器存储中不存在任何明文学生 code 或教师凭据。
- 两台不同设备上的教师与学生可以看到一致、正确的数据。
- 自动化测试证明学生不能访问其他学生的数据或未分配材料。
- 删除/停用学生或重置 code 后，旧会话立即失效。
- 录音不进入数据库 Base64，教师可在授权范围内稳定播放历史录音。
- 60 秒限制同时由前端和服务端验证。
- OCR 结果经教师确认后才发布给学生。
- 发音成绩来自音素级评测，或在界面上诚实标注为“转写匹配分”。
- 评分使用序列对齐，能够正确处理漏读、多读和替换。
- 学生端不显示文字纠错，只提供正确示范语音；教师端可以查看详细错词。
- 打卡由服务端在完成阅读后写入，月度和年度统计来自数据库。
