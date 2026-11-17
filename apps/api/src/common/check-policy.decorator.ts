import { SetMetadata } from '@nestjs/common';
import { type Permission } from '@hala/shared';

export const POLICY = 'hala:policy';
export const CheckPolicy = (permission: Permission) => SetMetadata(POLICY, permission);
