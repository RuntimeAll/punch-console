ALTER TABLE `generator` ADD `gen_key` text NOT NULL;--> statement-breakpoint
ALTER TABLE `generator` ADD `lv_支持` text;--> statement-breakpoint
ALTER TABLE `generator` ADD `样例题面` text;--> statement-breakpoint
CREATE UNIQUE INDEX `generator_key_uq` ON `generator` (`gen_key`);--> statement-breakpoint
ALTER TABLE `question` ADD `seed` integer;--> statement-breakpoint
ALTER TABLE `question` ADD `params` text;