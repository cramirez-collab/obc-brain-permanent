CREATE TABLE `inspection_marks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`fileId` int NOT NULL,
	`meshName` varchar(512) NOT NULL,
	`meshIndex` int NOT NULL,
	`userId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inspection_marks_id` PRIMARY KEY(`id`)
);
