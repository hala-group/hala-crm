import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { signalStore, withMethods, withState, patchState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type InviteUserInput } from '@hala/shared';
import { type UserVm } from '../../core/models';

interface InvitationResult { user: UserVm; invitation: { token: string; expiresAt: string } }

export const UsersStore = signalStore(
  { providedIn: 'root' },
  withState<{ users: UserVm[]; invitation: InvitationResult['invitation'] | null; loading: boolean }>({ users: [], invitation: null, loading: false }),
  withMethods((store, http = inject(HttpClient)) => ({
    async load(): Promise<void> {
      patchState(store, { loading: true });
      try { patchState(store, { users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')), invitation: null }); }
      finally { patchState(store, { loading: false }); }
    },
    async create(input: { name: string; email: string; roleId: string }): Promise<UserVm> {
      patchState(store, { loading: true });
      try {
        const user = await firstValueFrom(http.post<UserVm>('/api/v1/users', input));
        patchState(store, { users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')), invitation: null });
        return user;
      } finally {
        patchState(store, { loading: false });
      }
    },
    async invite(input: InviteUserInput): Promise<void> {
      const result = await firstValueFrom(http.post<InvitationResult>('/api/v1/users/invite', input));
      patchState(store, { invitation: result.invitation, users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')) });
    },
    async suspend(id: string): Promise<void> {
      await firstValueFrom(http.post(`/api/v1/users/${id}/suspend`, {}));
      patchState(store, { users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')) });
    },
    async update(id: string, roleId: string): Promise<void> {
      await firstValueFrom(http.patch(`/api/v1/users/${id}`, { roleId }));
      patchState(store, { users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')) });
    },
    async activate(id: string): Promise<void> {
      await firstValueFrom(http.patch(`/api/v1/users/${id}`, { status: 'active' }));
      patchState(store, { users: await firstValueFrom(http.get<UserVm[]>('/api/v1/users')) });
    },
    async remove(id: string): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/users/${id}`));
      patchState(store, { users: store.users().filter(user => user._id !== id) });
    }
  }))
);
