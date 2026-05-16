CREATE TABLE `chat_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`observationId` int,
	`rfiId` int,
	`userId` int NOT NULL,
	`message` text NOT NULL,
	`imageUrl` text,
	`mentions` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`category` enum('general','estructura','arquitectura','instalaciones','seguridad','calidad') NOT NULL DEFAULT 'general',
	`priority` enum('baja','media','alta','critica') NOT NULL DEFAULT 'media',
	`status` enum('abierta','en_revision','resuelta','cerrada') NOT NULL DEFAULT 'abierta',
	`location` text,
	`photoUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `observations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rfi_attachments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rfiId` int NOT NULL,
	`userId` int NOT NULL,
	`imageUrl` text NOT NULL,
	`markupUrl` text,
	`caption` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rfi_attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rfis` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`assignedToUserId` int,
	`number` int NOT NULL,
	`subject` varchar(500) NOT NULL,
	`description` text,
	`category` enum('diseno','estructura','instalaciones','arquitectura','coordinacion','otro') NOT NULL DEFAULT 'otro',
	`priority` enum('baja','media','alta','urgente') NOT NULL DEFAULT 'media',
	`status` enum('borrador','enviada','en_revision','respondida','cerrada') NOT NULL DEFAULT 'borrador',
	`dueDate` timestamp,
	`response` text,
	`respondedByUserId` int,
	`respondedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rfis_id` PRIMARY KEY(`id`)
);
