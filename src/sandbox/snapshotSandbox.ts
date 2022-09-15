/**
 * @author Hydrogen
 * @since 2020-3-8
 */
import type { SandBox } from '../interfaces';
import { SandBoxType } from '../interfaces';

function iter(obj: typeof window, callbackFn: (prop: any) => void) {
  // eslint-disable-next-line guard-for-in, no-restricted-syntax
  // 遍历对象自身和原型上的属性
  for (const prop in obj) {
    // patch for clearInterval for compatible reason, see #1490
    // 找到自身属性，方法不需要保存
    if (obj.hasOwnProperty(prop) || prop === 'clearInterval') {
      callbackFn(prop);
    }
  }
}

/**
 * 基于 diff 方式实现的沙箱，用于不支持 Proxy 的低版本浏览器
 */
export default class SnapshotSandbox implements SandBox {
  // 
  proxy: WindowProxy;

  // 沙箱的名称
  name: string;

  // 沙箱的类型
  type: SandBoxType;

  // 沙箱的运行状态
  sandboxRunning = true;

  // 全局环境的快照
  private windowSnapshot!: Window;

  // 全局环境的变更
  private modifyPropsMap: Record<any, any> = {};

  /**
   * 构造快照沙盒
   * @param name 微应用的名称
   */
  constructor(name: string) {
    this.name = name;
    this.proxy = window;
    this.type = SandBoxType.Snapshot;
  }

  active() {
    // 记录当前快照,记录当前的window的情况
    this.windowSnapshot = {} as Window;
    iter(window, (prop) => {
      this.windowSnapshot[prop] = window[prop];
    });

    // 恢复之前的变更
    Object.keys(this.modifyPropsMap).forEach((p: any) => {
      window[p] = this.modifyPropsMap[p];
    });

    this.sandboxRunning = true;
  }

  inactive() {
    // 全局环境的变更情况
    this.modifyPropsMap = {};

    // 当前这个微应用的window
    iter(window, (prop) => {
      //  当前环境下的window和原始window对象对比属性，不同的属性即被当前微应用修改过的
      if (window[prop] !== this.windowSnapshot[prop]) {
        // 记录变更，恢复环境
        this.modifyPropsMap[prop] = window[prop];
        // 恢复window
        window[prop] = this.windowSnapshot[prop];
      }
    });

    // 开发环境下，打印出当前微应用下全局环境的变化
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} origin window restore...`, Object.keys(this.modifyPropsMap));
    }

    // 沙箱的运行状态
    this.sandboxRunning = false;
  }
}
