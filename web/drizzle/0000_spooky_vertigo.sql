CREATE TABLE `asset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_id` integer NOT NULL,
	`类型` text NOT NULL,
	`路径` text NOT NULL,
	`配图顺序` integer,
	`rendered_at` text,
	FOREIGN KEY (`doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_uq` ON `asset` (`doc_id`,`类型`,`路径`);--> statement-breakpoint
CREATE INDEX `asset_doc_idx` ON `asset` (`doc_id`);--> statement-breakpoint
CREATE TABLE `collection_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`合刊doc_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`day` integer,
	`section` text,
	`seq` integer,
	FOREIGN KEY (`合刊doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_item_uq` ON `collection_item` (`合刊doc_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `collection_item_doc_idx` ON `collection_item` (`合刊doc_id`);--> statement-breakpoint
CREATE TABLE `doc` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`名称` text NOT NULL,
	`类型` text NOT NULL,
	`组名` text,
	`版本名` text,
	`科目` text,
	`年级` text,
	`考点` text,
	`册型` text DEFAULT '单册',
	`人工态` text,
	`layout_key` text,
	`day_spec` text,
	`源文件路径` text,
	`网盘链接` text,
	`提取码` text,
	`线上book_id` text,
	`备注` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_name_version_uq` ON `doc` (`名称`,`版本名`);--> statement-breakpoint
CREATE INDEX `doc_type_idx` ON `doc` (`类型`);--> statement-breakpoint
CREATE TABLE `generator` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`名称` text NOT NULL,
	`覆盖考点` text,
	`脚本路径` text,
	`备注` text
);
--> statement-breakpoint
CREATE TABLE `material` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_id` integer NOT NULL,
	`账号` text NOT NULL,
	`is_active` integer DEFAULT 1,
	`标题` text,
	`正文` text,
	`话题词` text,
	`风格种子` text,
	`burned` integer DEFAULT 0,
	`商品描述` text,
	`网盘分享语` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `material_doc_idx` ON `material` (`doc_id`);--> statement-breakpoint
CREATE TABLE `publish_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`日期` text,
	`结果` text,
	`备注` text,
	FOREIGN KEY (`material_id`) REFERENCES `material`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `publish_log_material_idx` ON `publish_log` (`material_id`);--> statement-breakpoint
CREATE TABLE `question` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_id` integer,
	`day` integer,
	`section` text,
	`seq` integer,
	`stem` text NOT NULL,
	`answer` text,
	`steps` text,
	`考点` text,
	`题型` text,
	`难度` text,
	`来源` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	`hash_L1` text,
	`实算` text DEFAULT '待算',
	`向量` blob,
	`mother_id` integer,
	`var_level` text,
	`generator_id` integer,
	FOREIGN KEY (`doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `question_doc_idx` ON `question` (`doc_id`);--> statement-breakpoint
CREATE INDEX `question_hash_idx` ON `question` (`hash_L1`);--> statement-breakpoint
CREATE INDEX `question_type_idx` ON `question` (`题型`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`标题` text NOT NULL,
	`详情` text,
	`素材路径` text,
	`类型` text DEFAULT 'agent',
	`状态` text DEFAULT '排队',
	`排序` integer DEFAULT 0,
	`关联doc_id` integer,
	`model` text DEFAULT 'opus',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`关联doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_state_idx` ON `task` (`状态`);