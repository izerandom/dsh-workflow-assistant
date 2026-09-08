# MySQL 模板与速查（Schema Templates）

本文件提供：设计稿骨架、字段描述表、建表 DDL 示例、存量变更迁移示例、类型速查。**以 MySQL 为默认**；项目另有约定（引擎/字符集/命名/迁移工具）时以 AGENTS.md 为准。设计稿格式**以本文件为唯一权威**，不参考项目里旧文档格式。

## 一、设计稿骨架（designs/T-YYYYMMDD-xxx-db.md）

```
# 数据库设计稿：<标题>

- 场景：新建 / 存量调整
- 关联工作单：T-YYYYMMDD-xxx（独立请求可无）
- 日期 / 决策人：

## 1. 现状摘要（存量调整必填）
- 表清单 / 关键表摘要（含盘点来源）
- 最新迁移版本基线：
- 项目约定（引擎 / 字符集 / 命名 / 外键 / 软删 / 审计字段）：

## 2. 实体与关系
| 实体/表 | 业务含义 | 关系 | 基数 | 删除策略 |

## 3. 字段总表（逐实体一张，见模板二）

## 4. 约束与索引总表
| 表 | 类型（PK/唯一/外键/普通索引） | 涉及字段 | 服务对象/依据 | 是否业务唯一 |

## 5. 建表 / 迁移文件计划
| 文件 | 类型（建表/变更） | 变更点摘要 | up 要点 | down/回滚要点 |

## 6. 验收对账
| 检查项 | 结果（通过/未通过） | 证据 |

## 7. 遗留风险
- 未对真实库执行验证；由后续实现切片集成测试接住。

## 8. 变更记录
| 时间 | 变更内容 | 原因 | 决策人 |
```

## 二、字段描述表模板（每实体一张）

| 字段 | MySQL 类型 | NULL/默认 | 约束/索引 | 业务含义 | 来源（需求/接口） | 状态（已确认/假设） |
|---|---|---|---|---|---|---|
| id | BIGINT UNSIGNED | NOT NULL | PK, AUTO_INCREMENT | 主键 | 通用 | 已确认 |
| user_id | BIGINT UNSIGNED | NOT NULL | KEY idx_user_id | 下单用户 | 接口 A | 已确认 |

约束：字段必须能对齐接口数据契约与查询路径；「假设」行必须显式标注，供用户批量否决。

## 三、建表 DDL 示例（MySQL 8）

```sql
-- 订单主表（示例：订单 + 订单明细，见关系说明）
CREATE TABLE `orders` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `order_no`     VARCHAR(32)     NOT NULL COMMENT '订单号（业务唯一）',
  `user_id`      BIGINT UNSIGNED NOT NULL COMMENT '下单用户 ID',
  `status`       VARCHAR(20)     NOT NULL DEFAULT 'pending' COMMENT '状态：pending/paid/shipped/cancelled',
  `total_amount` DECIMAL(12,2)   NOT NULL DEFAULT 0.00 COMMENT '订单总额（金额一律 DECIMAL）',
  `remark`       VARCHAR(255)    NULL DEFAULT NULL COMMENT '用户备注',
  `created_at`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_no` (`order_no`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订单主表';

CREATE TABLE `order_items` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `order_id`     BIGINT UNSIGNED NOT NULL COMMENT '所属订单（N:M 明细；是否启用外键约束按项目约定）',
  `sku_id`       BIGINT UNSIGNED NOT NULL COMMENT '商品 SKU',
  `quantity`     INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT '数量',
  `price`        DECIMAL(12,2)   NOT NULL COMMENT '成交单价',
  `created_at`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_order_id` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订单明细表';
```

## 四、存量变更迁移示例（up / down 成对）

```sql
-- 迁移 2026xxxxxx_add_orders_pay_at（示例：三步收紧 NOT NULL 的其中两步注释）
-- up：先加可空列（第一步）——旧版本应用不受影响
ALTER TABLE `orders`
  ADD COLUMN `pay_at` DATETIME(3) NULL DEFAULT NULL COMMENT '支付时间' AFTER `status`;

-- （第二步由应用灰度 + 回填脚本执行，不入本迁移）
-- down：回滚第一步
ALTER TABLE `orders`
  DROP COLUMN `pay_at`;
```

要点：三步收紧（加可空列 → 回填 → NOT NULL）按实际发布节奏拆成多个迁移/操作，**一个迁移只装一个内聚变更点**；down 必须能还原 up。

## 五、类型速查（MySQL）

| 用途 | 建议类型 | 说明 |
|---|---|---|
| 主键 | BIGINT UNSIGNED | 默认自增；跨系统/分表场景问用户（UUID/雪花） |
| 计数/数量 | INT UNSIGNED | 数量类；超 21 亿用 BIGINT |
| 状态码（纯数字） | SMALLINT / TINYINT | 仅当有完整映射文档；否则状态用 VARCHAR + 应用层常量 |
| 状态/枚举语义 | VARCHAR(20) | 演进最省事（默认假设）；是否 ENUM 见清单第 4 项 |
| 短文本 | VARCHAR(n) | n 按最大业务长度定，不拍脑袋 255 |
| 长文本 | TEXT（64KB 内） | 更长的用 MEDIUMTEXT/LONGTEXT，慎用 |
| 金额 | **DECIMAL(12,2) / DECIMAL(18,2)** | 禁止 FLOAT/DOUBLE（红旗） |
| 浮点 | 不用于存储 | 仅中间计算，不入库 |
| 时间 | **DATETIME(3)**（推荐） | TIMESTAMP 有 2038 与时区转换问题；毫秒精度用 (3) |
| 布尔 | TINYINT(1) | 或 BIT(1)，跟项目惯例 |
| 结构化数据 | JSON | MySQL 5.7+；跨库/复杂查询再评估 |

默认约定（以 AGENTS.md 为准）：表/字段 snake_case；索引命名 `idx_<列>`、唯一键 `uk_<列>`；审计字段 `created_at`/`updated_at` `DATETIME(3)`；软删 `deleted_at` 见项目约定。

## 六、对齐检查（验收用）

- [ ] 每条字段能回答：业务含义？来源（需求/接口）？是否为查询路径需要？
- [ ] 字段与接口数据契约、Go model（struct 标签）一致，无凭空字段
- [ ] 每个索引标注了服务对象（查询/接口/唯一性）
- [ ] 金额均 DECIMAL；无 FLOAT/DOUBLE 存金额
- [ ] 迁移 up/down 成对、编号在最新基线之后、一个迁移一个变更点
