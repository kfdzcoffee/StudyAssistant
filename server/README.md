# 学习助手云端同步服务

Node.js + Express + PostgreSQL 实现的云端同步服务，用于电脑端与手机端的数据同步。

## 架构

```
电脑端(本地文件权威) ──推送/拉取──▶ 云端同步服务 ──读取/订阅──▶ 手机端(云端权威)
```

- **电脑端**：本地文件是主副本，云端是备份 + 中转站
- **手机端**：只访问云端，不下载数据
- **同步粒度**：按记录增量同步（每条带 `updatedAt` + `version`）
- **冲突解决**：last-write-wins（后修改的赢），软删除传播

## 快速开始

### 1. 安装依赖
```bash
cd server
npm install
```

### 2. 配置 PostgreSQL
确保已安装 PostgreSQL，创建数据库：
```sql
CREATE DATABASE study_assistant;
```

### 3. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env，填写 DATABASE_URL 和 JWT_SECRET
```

### 4. 初始化数据库
```bash
npm run init-db
```

### 5. 启动服务
```bash
npm start
```

### 6. 访问管理面板
启动后浏览器打开 **http://localhost:3000/admin** 即可看到可视化配置管理面板：
- 📊 服务器状态总览（数据库连接、运行时长、用户/设备数）
- 📊 数据统计（各集合记录数）
- 👥 用户管理（查看/删除用户）

## API 接口

### 认证
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册 `{username, password, nickname}` |
| POST | `/api/auth/login` | 登录 `{username, password}`，返回 token |

### 同步（需 Authorization: Bearer <token>）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sync/:collection` | 推送记录 `{records: [...]}` |
| GET | `/api/sync/:collection?since=<ISO>` | 增量拉取 |
| GET | `/api/sync/:collection/all` | 全量拉取 |

`collection` 取值：`words`、`wenyan`、`todos`、`focus_records`、`errors`、`error_groups`

### 实时推送
WebSocket: `ws://host/ws?token=<token>`

## 记录格式

每条记录统一格式：
```json
{
  "id": "abc123",
  "updatedAt": "2026-08-21T10:30:00.000Z",
  "version": 5,
  "deleted": false,
  "...业务字段": "..."
}
```

## 🔒 安全说明

### 已内置的安全措施
- **JWT 认证**：所有同步接口需 `Authorization: Bearer <token>`，token 30 天有效
- **密码加密**：用户密码使用 bcrypt（cost 12）哈希存储，不存明文
- **输入校验**：用户名（3-20 位字母数字下划线）、密码（≥8 位含字母和数字）
- **限流**：登录/注册接口每 IP 每分钟最多 10 次，防止暴力破解
- **管理员独立认证**：管理面板需独立管理员账号，与用户系统隔离
- **审计日志**：登录、注册、管理员操作均记录到 `server/logs/audit.log`
- **密钥保护**：`JWT_SECRET` 不足 32 位时服务拒绝启动，防止弱密钥

### 生产环境部署建议
1. **必须使用 HTTPS**：通过 Nginx/Caddy 反向代理 + Let's Encrypt 免费证书
   ```nginx
   # Nginx 示例
   server {
     listen 443 ssl;
     server_name your-domain.com;
     ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       # WebSocket 支持
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
     }
   }
   ```
2. **收紧 CORS**：将 `.env` 中 `CORS_ORIGIN` 设为具体域名而非 `*`
3. **数据库权限**：使用独立低权限数据库账号，不要用 postgres 超级用户
4. **定期备份**：`pg_dump study_assistant > backup.sql`