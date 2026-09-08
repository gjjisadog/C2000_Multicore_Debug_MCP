import { z } from "zod";

/**
 * Shared by the MCP frontend, durable-plan validator, and daemon-side tools.
 * The safe default is intentional: repeated CPU2 Flash programming must never
 * become authorized because one side of the daemon boundary omitted a field.
 */
export const allowDestructiveFlashReloadSchema = z.boolean().default(false);

