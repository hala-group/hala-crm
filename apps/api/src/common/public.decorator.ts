import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'hala:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
