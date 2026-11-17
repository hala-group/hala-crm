import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { signalStore, withMethods, withState, patchState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type CreateRoleInput } from '@hala/shared';
import { type RoleVm } from '../../core/models';

export const RolesStore = signalStore(
  { providedIn: 'root' },
  withState<{ roles: RoleVm[]; loading: boolean }>({ roles: [], loading: false }),
  withMethods((store, http = inject(HttpClient)) => ({
    async load(): Promise<void> {
      patchState(store, { loading: true });
      try { patchState(store, { roles: await firstValueFrom(http.get<RoleVm[]>('/api/v1/roles')) }); }
      finally { patchState(store, { loading: false }); }
    },
    async create(input: CreateRoleInput): Promise<void> {
      await firstValueFrom(http.post('/api/v1/roles', input));
      patchState(store, { roles: await firstValueFrom(http.get<RoleVm[]>('/api/v1/roles')) });
    },
    async update(id: string, input: Partial<CreateRoleInput>): Promise<void> {
      await firstValueFrom(http.patch(`/api/v1/roles/${id}`, input));
      patchState(store, { roles: await firstValueFrom(http.get<RoleVm[]>('/api/v1/roles')) });
    },
    async remove(id: string): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/roles/${id}`));
      patchState(store, { roles: store.roles().filter(role => role._id !== id) });
    }
  }))
);
