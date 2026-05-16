CREATE TABLE `annotations_3d` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`text` text NOT NULL,
	`category` enum('observacion','defecto','aprobado','informativo') NOT NULL DEFAULT 'observacion',
	`floorLabel` varchar(64),
	`posX` float NOT NULL,
	`posY` float NOT NULL,
	`posZ` float NOT NULL,
	`resolved` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `annotations_3d_id` PRIMARY KEY(`id`)
);
