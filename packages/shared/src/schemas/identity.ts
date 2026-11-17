import { z } from 'zod';
import { PERMISSIONS } from '../permissions.js';

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i);
export const idParamsSchema = z.object({ id: objectIdSchema });
export const tenantSlugSchema = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const passwordSchema = z.string().min(6).max(1024);
export const permissionSchema = z.enum(PERMISSIONS);

export const loginSchema = z.object({
  tenantSlug: tenantSlugSchema.optional(),
  email: emailSchema,
  password: z.string().min(1)
});
export const acceptInviteSchema = z.object({
  token: z.string().min(40),
  password: passwordSchema
});
export const inviteUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  roleId: objectIdSchema
});
export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  roleId: objectIdSchema
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema
});
export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roleId: objectIdSchema.optional(),
  status: z.enum(['active', 'suspended']).optional()
}).refine(value => Object.keys(value).length > 0);
export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(permissionSchema).max(PERMISSIONS.length).transform(values => [...new Set(values)])
});
export const updateRoleSchema = createRoleSchema.partial().refine(value => Object.keys(value).length > 0);

export type LoginInput = z.infer<typeof loginSchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
