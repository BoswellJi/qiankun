/**
 * @author Kuitos
 * @since 2020-05-15
 */

import type { FrameworkLifeCycles } from '../interfaces';

/**
 * 微应用生命周期中的钩子函数
 * @param global 
 * @returns 
 */
export default function getAddOn(global: Window): FrameworkLifeCycles<any> {
  return {
    async beforeLoad() {
      // eslint-disable-next-line no-param-reassign
      global.__POWERED_BY_QIANKUN__ = true;
    },

    async beforeMount() {
      // eslint-disable-next-line no-param-reassign
      global.__POWERED_BY_QIANKUN__ = true;
    },

    async beforeUnmount() {
      // eslint-disable-next-line no-param-reassign
      delete global.__POWERED_BY_QIANKUN__;
    },
  };
}
