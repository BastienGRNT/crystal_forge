-- Ces réglages avaient des valeurs par défaut propres à l'infrastructure d'origine ; ils
-- sont désormais vides par défaut. Sur une installation déjà en service (compte admin
-- créé), la valeur dont elle dépendait est enregistrée explicitement, pour que rien ne
-- change. Sur une installation neuve (aucun admin), rien n'est inséré.
INSERT INTO `settings` (`key`, `value`, `is_secret`) SELECT 'network.publicIp', '51.68.180.212', 0 WHERE EXISTS (SELECT 1 FROM `admin`) AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'network.publicIp');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `is_secret`) SELECT 'proxmox.node', 'ns3125740', 0 WHERE EXISTS (SELECT 1 FROM `admin`) AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'proxmox.node');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `is_secret`) SELECT 'github.owner', 'BastienGRNT', 0 WHERE EXISTS (SELECT 1 FROM `admin`) AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'github.owner');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `is_secret`) SELECT 'safety.protectedCtids', '100,101,401,402,403,404', 0 WHERE EXISTS (SELECT 1 FROM `admin`) AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'safety.protectedCtids');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `is_secret`) SELECT 'network.reservedIps', '10.10.10.1,10.10.10.2,10.10.10.15,10.10.10.50,10.10.10.200', 0 WHERE EXISTS (SELECT 1 FROM `admin`) AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'network.reservedIps');
