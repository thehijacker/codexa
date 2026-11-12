# 📚 Codexa

**属于你自己的私人 EPUB 图书与漫画阅读平台——自托管、支持离线、并能与你的电子阅读器同步。**

Codexa 是一款自托管的 EPUB 与漫画阅读器，支持多用户、完全离线阅读、OPDS 浏览、双向 KOReader 同步以及内置词典查询——全部打包在一个轻量级的 Node.js 容器中。你可以在任意浏览器中阅读，将它安装为 PWA，或使用专用的 Android 和 iOS 应用，并在任何设备上从上次停下的地方继续。

> 📜 采用 AGPL-3.0 许可 · 🐳 单容器 Docker 部署 · 🔒 无云端、无追踪——你的书永远留在你自己的服务器上。

---

## 为什么选择 Codexa？

- **🛠️ 自带渲染引擎（CXReader）。** Codexa 不依赖通用的第三方 EPUB 库。CXReader 专为可靠性、忠实的排版以及在缓慢的墨水屏上稳健运行而打造——因此无论是棘手的现实世界 EPUB、固定布局漫画，还是 CBZ/CBR 漫画，都能得到同样精细的渲染。
- **📚 图书与漫画合并在同一个书库中。** 一流支持 EPUB、固定布局 EPUB、CBZ 和 CBR——无需分开的应用。
- **🔄 真正的双向 KOReader 同步。** 内置的 KOSync 兼容服务器让你的电子阅读器和手机保持在同一页——无需额外软件，无需云端。
- **🖥️ 真正随处可用。** 桌面浏览器、移动端 PWA、Android APK 和 iOS IPA，并提供一键式显示尺寸控制，可在从手机到大尺寸墨水屏平板再到桌面显示器的任何设备上缩放界面。
- **🔌 与你的技术栈良好兼容。** 浏览并下载任意 OPDS 目录（Calibre-Web、Komga、Kavita、Ubooquity……），并将整个文件夹同步到书架。
- **🛰️ 深度 BookOrbit 集成。** 原生的书库浏览器，下载前预览图书，并可选与自托管 BookOrbit 服务器双向同步高亮、阅读会话、进度以及状态/评分。
- **🏠 自托管且私密。** 多用户、JWT 认证，所有内容——图书、封面、高亮、位置——都存放在你的服务器上。

---

## 截图

| 书库 | OPDS 浏览器 | 图书信息 |
| :---: | :---: | :---: |
| ![书库](docs/screenshots/library.png) | ![OOPDS 浏览器](docs/screenshots/opds_browser.png) | ![图书信息](docs/screenshots/book_info.png) |
| **阅读界面** | **词典** | **搜索** |
| ![阅读界面](docs/screenshots/reader.png) | ![词典](docs/screenshots/dictionary.png) | ![搜索](docs/screenshots/search.png) |
| **目录** | **设置** | **水墨屏界面** |
| ![目录](docs/screenshots/toc.png) | ![设置](docs/screenshots/settings.png) | ![水墨屏界面](docs/screenshots/e-ink.png) |

### 移动端

| 书库 | 阅读界面 | 词典 | 水墨屏界面 |
| :---: | :---: | :---: | :---: |
| ![移动端书库](docs/screenshots/mobile/library.png) | ![移动端阅读界面](docs/screenshots/mobile/reader.png) | ![移动端词典](docs/screenshots/mobile/dictionary.png) | ![移动端水墨屏界面](docs/screenshots/mobile/eink.png) |

---

## 功能特性

### 阅读

- **CXReader** —— Codexa 自研的 EPUB 引擎；取代 epub.js，带来更好的可靠性和墨水屏兼容性
- **CBZ 和 CBR 漫画书** —— 直接阅读漫画压缩包；桌面上支持双页对开；自动 CBR→CBZ 转换；支持 ComicInfo.xml 元数据
- **固定布局 EPUB** —— 漫画、儿童读物和艺术书籍通过 CSS transform 缩放以像素级精确的尺寸渲染
- **精确位置恢复** —— 按章节保存页码；重新打开时定位到精确页面（而不仅仅是近似的百分比）
- **预览模式（Peek mode）** —— 以只读方式打开任意图书且不保存你的位置，包括尚未从已连接的 BookOrbit 服务器或 OPDS 目录下载的图书
- **书签** —— 添加、命名并跳转到书签；徽章显示书签数量
- **高亮与批注** —— 用四种颜色（黄色、绿色、蓝色、粉色）高亮，可选附加笔记；点按任意高亮即可编辑或删除
- **搜索** —— 书内全文搜索，带结果导航和返回/接受按钮
- **词典查询** —— 桌面端双击单词，移动端选中文本后点击词典图标；支持多个本地 StarDict 词典（`.ifo/.idx/.dict`）；首次打开时默认匹配图书自身语言的词典
- **支持中日韩（CJK）的选词功能** —— 对中文 / 日文 / 韩文进行正确的词语分词（而不是只按单个字符处理），同时也支持单字查询；在移动端，选择中日韩文本时会使用系统自带的原生选择控件，因此可以正常扩展 / 调整所选内容
- **脚注弹窗** —— 行内显示脚注和尾注，无需离开当前页面
- **仿生阅读（Bionic reading）** —— 强调单词前缀以引导视线，加快阅读速度
- **双页对开** —— 可选的并排布局，适用于较宽的屏幕
- **全屏模式** —— 隐藏所有浏览器界面元素，实现无干扰阅读
- **自动隐藏工具栏** —— 阅读时标题栏自动收起；悬停/点按时重新出现

### 主题与显示

- **7 种阅读主题** —— Light、Sepia、Dark、Sepia Dark、Midnight、Nord，外加一个可自由选色的**完全自定义**（Custom）主题
- **水墨屏模式（E-ink mode）** —— 针对墨水屏显示器优化的高对比度黑白模式
- **显示尺寸** —— 一键式界面缩放（自动 / 大 / 更大 / 最大），适用于手机、平板、墨水屏阅读器**和桌面浏览器**
- **自定义字体** —— 上传 `.ttf/.otf/.woff/.woff2` 字体（管理员）；可按每本书应用
- **详尽的文本设置** —— 字体、字号、行高、字间距、段落缩进、段落间距、对齐方式、按语言支持的连字符断字
- **可配置的状态栏** —— 最多 6 个叠加槽位（顶部/底部 × 左/中/右），可显示以下任意组合：章节/图书页码、剩余页数、进度百分比、预计读完时间、标题、作者、章节和当前时间
- **屏幕边缘内边距** —— 可调节的内缩，适配曲面屏手机和刘海屏
- **阅读器设置预设** —— 将你的主题、字体和布局设置保存为命名预设，并从主题标签页中切换；预设会在你的所有设备间同步，而每台设备会记住当前正在使用的预设（词典选择不包含在预设中）

### 同步与进度

- **自动保存进度** —— 进度保存到本地和服务器；可在任何设备上恢复
- **KOReader 同步** —— 内置 KOSync 兼容服务器；无需额外软件即可连接 KOReader 设备
- **外部 KOSync 服务器** —— 也可配合独立的 KOSync 服务器使用；位置不一致时提供冲突解决对话框
- **BookOrbit 扩展同步** —— 可选与自托管 BookOrbit 服务器双向同步高亮、阅读会话、实时阅读进度以及图书状态/评分
- **BookOrbit Dash** —— 一个专用的侧边栏面板，用于显示已连接的 BookOrbit 服务器中的账号全局阅读统计：当前 / 最长连续阅读天数、可编辑的年度阅读目标、正在阅读的书架、书库概览（图书 / 作者 / 系列 / 存储），以及从你同步的标注中提取的每日精选内容
- **中断会话恢复** —— 如果应用在章节中途被关闭，下次访问时会显示横幅，可一键恢复阅读

### 离线与移动端

- **离线阅读** —— 将任意图书下载到设备；无需网络即可阅读
- **PWA** —— 可安装在桌面和移动端；适配 iOS/Android 的安全区域和刘海屏
- **Android 应用** —— 音量键翻页、竖屏锁定、保持屏幕常亮开关、硬件墨水屏模式开关
- **iOS 应用** —— 侧载安装或通过 TestFlight 安装
- **响应式布局** —— 适用于手机、平板和桌面

### 书库

- **多用户** —— JWT 认证，每个用户有独立的书库和设置
- **书架（Shelves）** —— 将图书整理到命名的合集中；支持批量添加/移除
- **OPDS 浏览器** —— 以 BookOrbit 风格的文件夹树和卡片网格浏览任意 OPDS 目录（Calibre-Web、Komga、Kavita……），支持网格密度控制和按服务器的可达性状态；可下载图书或以只读方式预览而无需先下载
- **OPDS 书架同步** —— 将整个 OPDS 文件夹批量下载到书架；过期图书检测
- **BookOrbit 书库浏览器** —— 原生浏览自托管 BookOrbit 服务器的书库、智能筛选（smart scopes）、合集、系列和作者；将图书添加到 Codexa、无需下载即可预览、编辑合集成员，以及直接在 BookOrbit 上查看任意图书
- **BookOrbit 合集/智能筛选同步** —— 将书架链接到 BookOrbit 合集或智能筛选，实现一键重新同步，与 OPDS 书架同步相同
- **相关图书** —— 由已连接的 BookOrbit 服务器提供的“相似图书”、“该作者的更多作品”和“同系列更多作品”推荐，会同时显示在本地图书信息弹窗和 BookOrbit 书库自身的图书详情弹窗中
- **阅读统计** —— 阅读时长、翻页数、会话数、开始/完成的图书数、按图书的历史记录
- **系列支持** —— 系列名称、编号，以及一键系列筛选
- **排序与搜索** —— 按日期、标题、作者、进度或系列排序；实时书库搜索

### 管理

- **用户管理** —— 查看所有用户、删除账户
- **字体管理** —— 上传（带进度指示）和删除所有用户可用的自定义字体
- **词典管理** —— 上传 StarDict ZIP 压缩包（带进度指示）、删除词典
- **注册控制** —— 启用或禁用新用户注册
- **OIDC 登录** —— 可选通过 Google、Apple 或自托管提供商（Dex、Authelia、Keycloak……）实现单点登录，与本地账户并存——参见下方 [OIDC 登录](#oidc-登录googleapple自托管)
- **国际化**
- **8 种语言** —— 英语、斯洛文尼亚语、德语、西班牙语、法语、意大利语、葡萄牙语、简体中文

---

## 使用 Docker 快速开始

1. 复制示例 compose 文件

```bash
cp docker-compose.sample.yaml docker-compose.yaml
```

2. 设置一个强 JWT 密钥

```bash
# 生成密钥：
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# …或者：
openssl rand -hex 64
```

将输出结果粘贴到 `docker-compose.yaml` 中作为 `JWT_SECRET` 的值。

3. 启动

```bash
docker compose up -d
```

Codexa 现已运行在 **<http://localhost:3000>**。

注册第一个账户——没有默认的 admin 密码。

## 配置

所有配置均可通过环境变量完成：

| 变量 | 是否必需 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `JWT_SECRET` | **是** | — | 长随机字符串（≥ 64 字符）。更改它会使所有会话失效。 |
| `PORT` | 否 | `3000` | 服务器监听的 TCP 端口 |
| `DATA_DIR` | 否 | `./data` | 持久化数据（图书、封面、字体、数据库）的路径 |
| `CORS_ORIGIN` | 否 | （同源） | 允许的 CORS 来源，例如 `https://books.example.com` |
| `DEBUG` | 否 | `false` | 设为 `true` 启用详细的浏览器控制台日志（所有 `[reader]`、`[api]`、`[kosync]` 等消息）。默认关闭——只显示警告和错误。 |
| `OIDC_PROVIDERS` | 否 | _（无）_ | 要启用的 OIDC 提供商键的逗号分隔列表。参见 [OIDC 登录](#oidc-登录googleapple自托管)。 |
| `OIDC_BASE_URL` | 仅当设置了 `OIDC_PROVIDERS` 时 | — | Codexa 对外可访问的基础 URL，用于构建 OIDC 回调 URL |
| `OIDC_<KEY>_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_NAME` | 仅针对 `OIDC_PROVIDERS` 中的每个键 | — | 每个提供商的 OIDC 凭据和显示名称 |

---

## OIDC 登录（Google、Apple、自托管）

Codexa 支持通过任意标准 OIDC 提供商登录，作为本地用户名/密码注册的替代方案——Google、Apple，或你自己运行的自托管身份提供商。默认情况下它是禁用的；设置 `OIDC_PROVIDERS` 即可开启。

来自某个身份的首次成功登录会按两个步骤与现有账户匹配：

1. **按提供商 + 主体 ID（subject ID）**——如果这个确切的身份之前登录过，则复用该账户。
2. **按已验证的邮箱**——否则，如果提供商为该邮箱担保（发送 `email_verified: true`），并且它与某个现有的、尚未链接的本地账户（通过设置 → 邮箱，或在注册时设置）上的邮箱匹配，则链接该账户而不是创建新账户。这正是让已经本地注册的人开始使用 OIDC 而不会产生第二个空账户的机制——只需要两边的邮箱（Codexa 的设置和你的 OIDC 提供商的用户配置）匹配即可。

如果两者都不匹配，则**自动创建**新账户。Codexa 内部没有单独的管理员审批步骤——访问控制由你将 Codexa 指向的那个身份提供商负责。这正是在使用固定用户列表的自托管提供商（见下文）时，能够"预定义"谁可以登录的原因。

> **注意**：邮箱匹配只会链接到尚未链接到其他身份的账户——它不会重新分配已经绑定到另一个提供商的账户。
> 
> 不声明 `email_verified` 的提供商（或根本不发送邮箱的提供商）总是会直接创建新账户，绝不会通过未验证的邮箱链接——否则一个恶意或配置错误的提供商可能仅凭声称拥有某邮箱地址就接管一个不相关的本地账户。

> **注意**：不包含 Facebook——它没有实现标准 OIDC（没有发现文档，没有 `id_token`），因此无法使用这个通用集成。

> **注意**：通过 OIDC 创建的账户没有本地密码，因此无法用于登录 [KOReader 同步](#koreader-同步设置)（它使用用户名/密码认证）。如果你需要该账户也能用于 KOReader 同步，请先通过设置 → 修改密码来设置一个。

### 示例：Google

1. 在 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 中创建一个 OAuth 2.0 Client ID（Web 应用），授权重定向 URI 为 `https://<your-domain>/api/auth/oidc/google/callback`。
2. 设置环境变量：
   ```
   OIDC_PROVIDERS=google
   OIDC_BASE_URL=https://<your-domain>
   OIDC_GOOGLE_ISSUER=https://accounts.google.com
   OIDC_GOOGLE_CLIENT_ID=<your client id>
   OIDC_GOOGLE_CLIENT_SECRET=<your client secret>
   OIDC_GOOGLE_NAME=Google
   ```

Apple（Sign in with Apple）的工作方式相同，使用 `OIDC_APPLE_ISSUER=https://appleid.apple.com`，不同之处在于 Apple 的"client secret"本身是一个你用 Apple 私钥生成并签名的 JWT，有效期最长为 6 个月——你需要定期重新生成并重新部署它。

### 示例：使用预定义用户的自托管提供商（Dex）

如果你完全不想向第三方账户敞开大门，可以运行一个自己的最小化 OIDC 提供商，其中包含你自己定义的固定用户列表。[Dex](https://dexidp.io/) 很适合这个用途——一个小巧的单容器，无需数据库，用户直接在其配置文件中声明。

`dex-config.yaml`：

```yaml
issuer: https://auth.example.com/dex
storage:
  type: memory
web:
  http: 0.0.0.0:5556
staticClients:
  - id: codexa
    name: Codexa
    secret: <a-random-client-secret>
    redirectURIs:
      - https://books.example.com/api/auth/oidc/dex/callback
enablePasswordDB: true
staticPasswords:
  - email: "alice@domain.com"
    # 生成方式：htpasswd -bnBC 10 "" '<password>' | tr -d ':\n'
    hash: "<bcrypt hash>"
    username: "alice"
    userID: "1"
  - email: "bob@doma.com"
    hash: "<bcrypt hash>"
    username: "bob"
    userID: "2"
```

将 Dex 作为第二个服务添加到你的 `docker-compose.yaml` 中：

```yaml
services:
  codexa:
    image: ghcr.io/thehijacker/codexa:latest
    # ...已有配置...
    environment:
      JWT_SECRET: "..."
      OIDC_PROVIDERS: "dex"
      OIDC_BASE_URL: "https://books.example.com"
      OIDC_DEX_ISSUER: "https://auth.example.com/dex"
      OIDC_DEX_CLIENT_ID: "codexa"
      OIDC_DEX_CLIENT_SECRET: "<the same random client secret as above>"
      OIDC_DEX_NAME: "Home SSO"

  dex:
    image: dexidp/dex:latest
    container_name: dex
    restart: unless-stopped
    ports:
      - "5556:5556"
    volumes:
      - ./dex-config.yaml:/etc/dex/config.yaml
    command: ["dex", "serve", "/etc/dex/config.yaml"]
```

将 `books.example.com` 和 `auth.example.com` 都放在你的反向代理（参见[在反向代理后自托管](#设置反向代理)）之后并启用 HTTPS——OIDC 提供商通常要求 HTTPS 重定向 URI。这样只有你添加到 `staticPasswords` 中的用户名/密码才能登录 Codexa。

---

## 数据目录结构

```
data/
├── codexa.db          # SQLite 数据库（WAL 模式）
├── books/             # 上传的 EPUB 和 CBZ 文件（CBR 自动转换为 CBZ）
├── covers/            # 提取的封面图片
├── fonts/             # 用户上传的字体（.ttf/.otf/.woff/.woff2）
└── dictionaries/      # StarDict 词典文件（.ifo / .idx / .dict）
```

将此目录挂载为 Docker 卷，以便在容器更新时持久化所有数据。

---

## 更新

```bash
docker compose pull
docker compose up -d
```

数据库架构会在启动时自动迁移。

---

## KOReader 同步设置

Codexa 包含一个内置的 KOSync 兼容服务器。

在 KOReader 中：

1. 进入 **工具 → KOReader Sync**
2. 将**自定义同步服务器**设为你的 Codexa URL（例如 `https://books.example.com`）
3. 使用与 Codexa 相同的凭据登录

或者，你也可以在**设置 → KOReader Sync** 中连接到外部 KOSync 服务器。

---

## OPDS

在侧边栏中导航到**在线书库**（一旦配置了至少一个服务器就会出现）。

在**设置 → OPDS 服务器**中添加任意 OPDS 兼容目录（Calibre-Web、Komga、Kavita、Ubooquity、Bookwyrm……）。

通过左侧的文件夹树和右侧的卡片网格浏览。每张图书卡片都可以**下载**或**预览**——预览（Peek）以只读方式打开图书，完全不会将它下载到你的书库中；文件会被获取到临时位置，并在你关闭阅读器时自动清理。

---

## BookOrbit

在**设置 → BookOrbit** 中添加你的服务器 URL，即可启用原生书库浏览器（书库、智能筛选、合集、系列、作者），并可选双向同步高亮、阅读会话、阅读进度和状态/评分。需要 BookOrbit **v2.1.0 或更高版本**。

智能筛选书架同步使用 BookOrbit 的认证图书查询 API，而不是受 App Attest 保护的智能筛选 GET 接口。其他受 App Attest 保护的 API 可能仍无法在 Codexa 中使用。

开启扩展同步后，还会新增两项功能：

- **BookOrbit Dash** —— 一个侧边栏面板，用于展示账号范围内的阅读统计：连续阅读天数、可编辑的年度阅读目标、正在阅读的书架、书库概览，以及来自你同步标注的每日精选。这些内容使用 BookOrbit 自带的阅读会话和仪表盘 API —— 由于 Codexa 在扩展同步中本身就会向 BookOrbit 上报阅读会话，因此从开启同步的那一刻起，这些数据就会反映真实的阅读活动。
- **相关图书** —— 在图书详情页中新增“相关”标签页（相似图书 / 该作者的更多作品 / 同系列更多作品），无论是查看你自己书库中的图书，还是浏览 BookOrbit 目录时都会显示。该功能由 BookOrbit 的推荐引擎驱动 —— 阅读 / 评分历史过少的图书可能会显示较少结果，甚至没有结果；如果是非常老旧、不支持这些 API 的 BookOrbit 服务器，则只会显示一个空白标签页。

---

## 词典查询

将 StarDict 词典文件放入 `data/dictionaries/`。

支持的扩展名：`.ifo`、`.idx`、`.dict`、`.dict.dz`

在**阅读器 → 设置 → 词典**中启用并排序词典。

管理员可以直接从设置页面上传打包好的词典（包含 StarDict 文件的 ZIP 压缩包）。

---

## 离线阅读

打开任意图书或漫画的详情面板，点按"**下载以供离线阅读**"。文件会由 service worker 缓存，即使没有网络连接也可用。从同一面板，或从侧边栏的"**已下载**"书架中移除已缓存的图书。

---

## 键盘快捷键

当焦点不在文本输入框内时快捷键有效。

### 导航

| 按键 | 操作 |
| --- | --- |
| `→` / `空格` / `Page Down` | 下一页 |
| `←` / `Page Up` | 上一页 |

### 面板

| 按键 | 操作 |
| --- | --- |
| `K` | 打开 / 关闭目录 |
| `I` | 打开 / 关闭书内搜索 |
| `S` | 打开 / 关闭阅读器设置 |
| `Esc` | 关闭已打开的面板——或返回书库 |

### 视图

| 按键 | 操作 |
| --- | --- |
| `F` | 切换全屏 |

---

## 从源码构建

```bash
git clone https://github.com/thehijacker/codexa.git
cd codexa
cp .env.example .env
# 编辑 .env 并设置 JWT_SECRET
npm install
npm start
```

需要 **Node.js ≥ 18**。

---

## 设置反向代理

Codexa 只提供纯 HTTP 服务。请用 nginx、Caddy 或 Traefik 反向代理以启用 HTTPS。

最小化 nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name books.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        client_max_body_size 300M;
    }
}
```

---

## 许可证

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) © Andrej Kralj

你可以自由地使用、修改和自托管本软件。如果你分发修改后的版本（包括通过网络分发），你必须以相同的许可证发布源代码。
