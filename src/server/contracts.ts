import type { Order, OrderView, Product, Settings, Submission, User } from '../shared/types';
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface Repository {
  profile(id: string): Promise<User | null>;
  saveProfile(user: User): Promise<void>;
  products(all?: boolean): Promise<Product[]>;
  product(id: string): Promise<Product | null>;
  saveProduct(product: Product): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings, actor: string): Promise<void>;
  orders(userId?: string): Promise<OrderView[]>;
  order(id: string): Promise<OrderView | null>;
  createOrder(order: Order): Promise<OrderView>;
  submitOrder(id: string, userId: string, submission: Submission): Promise<void>;
  decideOrder(id: string, actor: string, approve: boolean, reason: string): Promise<void>;
  owns(userId: string, productId: string): Promise<boolean>;
  rateLimit(key: string, limit: number, seconds: number): Promise<boolean>;
}
export type AuthResult = { user: User; token: string; refresh?: string };
export interface Auth {
  register(input: { name: string; phone: string; email: string; password: string }): Promise<AuthResult>;
  login(phone: string, password: string): Promise<AuthResult>;
  resolve(token?: string, refresh?: string): Promise<AuthResult | null>;
  logout(token?: string): Promise<void>;
}
export interface Files {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<{ body: BodyInit; size: number } | null>;
}
export type Services = { repo: Repository; auth: Auth; files: Files; local: boolean };
