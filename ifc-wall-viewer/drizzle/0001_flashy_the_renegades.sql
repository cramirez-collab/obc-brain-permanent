CREATE TABLE `project_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`specialty` varchar(64) NOT NULL,
	`label` varchar(255) NOT NULL,
	`url` text NOT NULL,
	`fileKey` text NOT NULL,
	`color` varchar(16) NOT NULL,
	`transparent` int NOT NULL DEFAULT 0,
	`opacity` int NOT NULL DEFAULT 100,
	`showEdges` int NOT NULL DEFAULT 0,
	`vertexCount` int DEFAULT 0,
	`fileSize` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `project_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` enum('processing','ready','error') NOT NULL DEFAULT 'processing',
	`thumbnail` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
