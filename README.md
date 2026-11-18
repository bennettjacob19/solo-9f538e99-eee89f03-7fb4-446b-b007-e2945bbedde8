# 本地服务发现目录（svcdir）

一个运行在 Flask + SQLite 上的小型服务发现目录：运维人员可以在网页上修改
「服务名 → 目标地址」的映射、创建命名备份、并从一个备份恢复。另有 `/resolve`
查询 API 供客户端使用。

## 启动

### Docker Compose（推荐）

```bash
docker compose up --build
```

启动后可验证长轮询（立即返回当前版本，或最多等 15 秒）：

```bash
V=$(curl -s http://localhost:8000/api/state | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')
curl -s "http://localhost:8000/api/changes?since=$V&wait=15"
```

- 网页：<http://localhost:8000/>
- API：`GET http://localhost:8000/resolve?name=orders-api`
- 健康检查：`GET /healthz`
- SQLite 数据与备份都位于命名卷 `svcdir-data` 的 `/data/directory.sqlite3`
  （备份是同一数据库里的版本快照，所以备份与恢复天然原子）。

### 本地运行

```bash
python3 -m pip install -r requirements.txt
SVCDIR_DB=./data/directory.sqlite3 python3 -m svcdir   # 开发用内置服务器
# 或： gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 8 svcdir.__main__:app
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SVCDIR_DB` | `data/directory.sqlite3` | SQLite 文件路径 |
| `SVCDIR_RESTORE_LEASE_SECONDS` | `30` | 恢复租约时长（进程异常死亡后的兜底回收上限） |
| `PORT` | `8000` | 仅用于 `python -m svcdir` |

## 页面与 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 网页：目录、修改表单、备份列表、恢复按钮 |
| GET | `/resolve?name=<服务名>` | 返回单个服务的地址 |
| GET | `/resolve` | 返回整个当前目录 |
| GET | `/api/state` | 当前版本、完整目录、恢复状态、备份列表 |
| GET | `/api/backups` | 备份列表 |
| GET | `/api/changes?since=<版本>[&wait=<秒>]` | 长轮询变更（见下） |
| POST | `/api/services` | `{"service": ..., "address": ..., "note": ...}` 新增/修改 |
| DELETE | `/api/services/<名>` | 删除 |
| POST | `/api/backups` | `{"name": ...}` 创建命名备份 |
| GET | `/api/backups/<名>/validate` | 校验备份（不修改目录） |
| POST | `/api/backups/<名>/restore` | 从备份恢复 |

浏览器表单走 `POST /services`、`/backups`、`/backups/<名>/restore`，
成功后 303 跳回页面并显示结果或错误。

查询响应示例：

```json
{"ok": true, "version": 6, "restore_in_progress": false,
 "name": "orders-api", "address": "10.0.0.12:8080"}
```

## 客户端变更监听（长轮询）

客户端缓存目录后，地址可能因为改址、删除或备份恢复而过期。`GET /api/changes`
让客户端用「上次收到的目录版本」作为游标等待变更：

```bash
curl 'http://localhost:8000/api/changes?since=6'
```

- **参数**：`since`（也接受别名 `cursor`）是上次收到的目录版本；`wait`（别名
  `timeout`）是最多等待的秒数，默认且最多 **15 秒**，`0` 表示立即返回。
- **有新提交**：立即返回当前版本与相对旧游标的净变化：

  ```json
  {"ok": true, "since": 6, "version": 9, "changed": true, "timed_out": false,
   "changes": {
     "added":   [{"service": "payments", "address": "10.0.0.30:80"}],
     "updated": [{"service": "orders-api", "old_address": "10.0.0.12:8080",
                  "address": "10.0.0.13:8080"}],
     "removed": [{"service": "legacy", "address": "10.0.0.9:80"}]
   },
   "version_info": {"version": 9, "created_at": "...", "kind": "restore",
                    "note": "恢复备份 nightly"}}
  ```

- **净变化**：变化由两个完整不可变版本直接比较得出，因此连续多次修改、或是
  一次恢复，都只返回 `since -> 当前版本` 的最终差异。
- **版本只增不减**：即使目录内容回到与游标完全一致（例如改回原地址、或恢复
  到内容相同的备份），`version` 也会前进；此时 `changes` 三个列表为空，
  `changed` 仍为 `true`。
- **超时**：返回原版本、`timed_out: true` 和三个空列表（并带 `retry_after`），
  客户端用同一个 `since` 继续等待即可。
- **未知 / 未来版本**：游标对应的版本不存在 → `404 unknown_version`；游标高于
  当前版本 → `409 future_version`。省略 `since` 则返回当前版本和空变化，
  用于首次获取游标（配合 `/api/state` 读取完整目录）。
- **读库失败不会被伪装成超时**：数据库错误按原样返回 `500`/`503`。
- **等待期间一切照常**：写、删除、创建备份与恢复都不被长轮询阻塞；恢复进行
  中等待依旧持续，恢复提交后立即返回新版本。进程内提交会即时唤醒等待者，
  其他进程的提交由最多 1 秒一次的轻量版本检查发现。
- **重启后可追赶**：游标就是数据库里的版本号，进程重启后仍可用旧游标调用
  `/api/changes` 得到净变化（旧版本行永不删除）。

网页上的「变更监听」卡片可手动开启监听：操作目录（新增、改址、删除、恢复）
后即可看到返回的变化列表和新版本号，目录表与版本徽标也会同步刷新。

## 一致性与恢复语义

实现要点（对应需求逐条）：

- **备份是同一提交点的完整目录。** 目录从不原地修改：每次修改都写入一个
  *完整的新版本*（先复制当前版本的全部行，再改一行），最后一条
  `UPDATE meta SET value=<新版本>` 才是发布。备份行只固定「版本号」，因此
  创建备份期间持续写入不会让备份变成半个目录。
- **恢复前校验。** 恢复分为三步：①在一个写事务里登记「恢复中」租约；②只读
  事务里校验备份（条目数、每行服务名/地址合法性、重复服务名、SHA-256 摘要与
  备份记录比对）；③一个原子写事务创建完整的新版本并切换 `current_version`。
  校验失败 → 直接返回 422，目录一个字节都不动。
- **恢复期间查询仍返回当前完整目录。** `current_version` 只在最后一步切换，
  查询永远读它；整个查询在读事务快照里完成，因此不会读到混排的数据。
- **新修改明确拒绝，已受理的修改先结算。** 登记恢复意图需要写锁，所有已受理
  的修改必然先提交完成；之后到达的修改看到有效租约，返回 `409
  restore_in_progress`（网页也会明确提示）。
- **恢复后新查询只见备份地址；先前受理的查询不混用两版。** 切换后新查询用新
  版本；一个在切换前开始的查询持有自己的读快照（`store.read_view()`），
  即使内部重复读取也仍是同一版本。
- **切换中断后重启只呈现原版或完整备份版。** 新版本与版本号切换在同一事务内
  提交；崩在提交前 → 仍是原版，崩在提交后 → 是完整备份版，旧版本的行永不删除。
  恢复者用租约 + 操作系统文件锁（`<db>.restore.lock`）标记存活：进程死亡时
  内核释放锁，重启后立即回收被遗弃的「恢复中」标记，不必等租约到期。
- **并发恢复。** 文件锁 + 数据库内的 `restore_state` 双重互斥，第二个恢复请求
  得到 409。

## 测试

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
```

关键交错场景覆盖在 `tests/test_svcdir.py`：

- `test_writes_rejected_while_restore_in_progress_and_settled_before`
- `test_query_accepted_before_switch_keeps_one_version`
- `test_concurrent_writers_during_restore_never_mix`
- `test_cross_process_readers_and_writer_during_restore`（独立进程 + WAL 快照）
- `test_corrupt_backup_is_rejected_and_directory_unchanged`
- `test_backup_with_missing_rows_is_rejected`
- `test_interrupted_switch_presents_original_or_complete_backup`
- `test_killed_restorer_leaves_original_and_restart_can_retry`（SIGKILL 恢复进程）
- `test_expired_restore_lease_is_reclaimed_after_restart`
- `test_dead_restorer_is_reclaimed_immediately_on_restart`
- `test_restore_can_run_after_prior_abandoned_marker`
- `test_live_restore_lease_survives_sibling_process_initialization`
- `test_backup_row_pins_one_version_during_continuous_writes`
- `test_changes_collapse_continuous_edits_to_final_state`
- `test_version_advances_even_when_content_returns_to_original`
- `test_changes_after_restore_report_net_effect`
- `test_wait_returns_as_soon_as_a_change_commits` / `test_wait_during_restore_keeps_polling_and_sees_new_version`
- `test_wait_surfaces_database_failure_instead_of_faking_timeout`
- `test_old_cursor_still_catches_up_after_restart`
- `test_http_change_endpoint` / `test_http_change_endpoint_timeout_and_errors`
- `test_http_rejects_writes_and_serves_reads_during_restore`
- `test_api_flow` / `test_html_page_and_forms` / `test_html_escapes_hostile_names`
- `test_api_validation_errors_are_json` / `test_edge_case_inputs_are_rejected_cleanly`

## 布局

```
svcdir/errors.py     错误类型 → HTTP 状态码
svcdir/store.py      目录版本、命名备份、校验、恢复（核心逻辑）
svcdir/web.py        Flask 路由：网页 + API
svcdir/templates/    页面模板
tests/test_svcdir.py 自测（含并发交错）
Dockerfile / docker-compose.yml
```

## 已知限制与未完成项

- **未在 Docker 中实际构建/运行。** 本环境没有 Docker（`docker` 命令不存在），
  因此 Dockerfile 与 compose 文件只做了静态检查。应用本身已用
  `python -m svcdir` 与 gunicorn 在真实 HTTP 上跑通。
- 单容器部署，恢复互斥依赖同一文件系统上的 `flock`；若把数据目录放到不支持
  `flock` 的网络文件系统，会退化为「租约到期才算失效」。
- 备份保存在同一 SQLite 数据库中，可防止误改目录，但不能防磁盘/文件损坏；
  需要异地容灾应另行导出备份文件。
- 未做用户认证与 HTTPS——按需求这是本地运维工具，请只在内网使用。
- 恢复的「已受理查询」保证依赖单个查询请求只在一个读事务里读完（当前实现如此）；
  没有为客户端提供跨多个独立 HTTP 请求的版本固定参数。
- 长轮询等待者占一个 Web 线程；镜像内的 gunicorn 配置了 16 个线程。若大量客户端
  长期长轮询，需要相应调高线程数或改用专门的事件驱动部署。
- 跨进程的提交没有通知机制（SQLite 无跨进程唤醒），其他进程的变更最多滞后
  `CHANGE_POLL_INTERVAL`（1 秒）被发现；同一进程内提交即时唤醒。
