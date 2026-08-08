CREATE TABLE `doc_member` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`合刊doc_id` integer NOT NULL,
	`成员doc_id` integer NOT NULL,
	`排序` integer DEFAULT 0,
	FOREIGN KEY (`合刊doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`成员doc_id`) REFERENCES `doc`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_member_uq` ON `doc_member` (`合刊doc_id`,`成员doc_id`);--> statement-breakpoint
CREATE INDEX `doc_member_collection_idx` ON `doc_member` (`合刊doc_id`);--> statement-breakpoint
CREATE INDEX `doc_member_member_idx` ON `doc_member` (`成员doc_id`);