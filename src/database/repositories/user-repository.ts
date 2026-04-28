import type { User } from '../types';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByPrivyDid(privyDid: string): Promise<User | null>;
  findOrCreateByPrivyDid(
    privyDid: string,
    claims: { email?: string },
  ): Promise<User>;
}
