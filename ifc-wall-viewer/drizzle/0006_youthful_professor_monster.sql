ALTER TABLE `project_files` ADD `conversionStatus` enum('ready','pending_conversion') DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_files` ADD `originalFormat` varchar(16);