-- Runs once, when the database volume is first created. POSTGRES_DB already made `deskzo` (the first
-- workspace's database); these are the other two the platform needs. Workspaces' own databases are
-- made later, one per signup, by the worker (PLATFORM_PROVISIONER_URL).
CREATE DATABASE deskzo_control;
CREATE DATABASE deskzo_reference;
