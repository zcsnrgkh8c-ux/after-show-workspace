/**
 * 规划等待态守卫。
 *
 * 切换步行/公交、修改起终点或偏好在途请求会失效；旧请求晚到不得写结果，
 * 更不得提前解除**新请求**的等待态（否则新请求还在跑，按钮已恢复可点、列表空白）。
 * 只有当前活动请求的完成才能 settle 并关闭 loading。
 */
export class PlanGate {
  private seq = 0;
  private active: number | null = null;

  /** 发起新请求：返回本次令牌，并成为唯一活动请求 */
  begin(): number {
    const seq = (this.seq += 1);
    this.active = seq;
    return seq;
  }

  /** 使所有在途请求失效（React 状态由调用方同步复位） */
  invalidate(): void {
    this.seq += 1;
    this.active = null;
  }

  /** 旧请求完成时返回 false：调用方不得写结果、不得改等待态 */
  isActive(seq: number): boolean {
    return this.active === seq;
  }

  /** 当前请求结束；旧请求返回 false，不触碰等待态 */
  settle(seq: number): boolean {
    if (this.active !== seq) return false;
    this.active = null;
    return true;
  }
}
