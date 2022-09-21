/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  HTMLContentRender,
  LifeCycleFn,
  LoadableApp,
  ObjectType,
} from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import { lexicalGlobals } from './sandbox/common';
import {
  Deferred,
  genAppInstanceIdByName,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceGetEntriesByName,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

/**
 * 链式执行Promise
 * @param hooks 
 * @param app 
 * @param global 
 * @returns 
 */
function execHooksChain<T extends ObjectType>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

/**
 * 验证微应用架构是否为单一模式
 * @param validate 
 * @param app 
 * @returns 
 */
async function validateSingularMode<T extends ObjectType>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

const supportShadowDOM = !!document.head.attachShadow || !!(document.head as any).createShadowRoot;

/**
 * 创建子应用dom节点
 * @param appContent 子应用入口html字符串 
 * @param strictStyleIsolation 严格样式隔离
 * @param scopedCSS 作用域css
 * @param appInstanceId 子应用的id
 * @returns 
 */
function createElement(
  appContent: string,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  appInstanceId: string,
): HTMLElement {
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // appContent always wrapped with a singular div
  // appContent都是用一个单独div包裹
  const appElement = containerElement.firstChild as HTMLElement;
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      // 将dom元素连附加到阴影dom树
      if (appElement.attachShadow) {
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  if (scopedCSS) {
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appInstanceId);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appInstanceId);
    });
  }

  return appElement;
}

/** generate app wrapper dom getter */
// 生成微应用包公dom访问器
function getAppWrapperGetter(
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');
      // 获取微应用的容器dom
      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appInstanceId} is not existed!`);
      return appWrapper!;
    }
    // 获取dom
    const element = elementGetter();
    assertElementExist(element, `Wrapper element for ${appInstanceId} is not existed!`);

    if (strictStyleIsolation && supportShadowDOM) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * 获取渲染函数
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * 如果提供了遗留的渲染函数，
 * @param appInstanceId
 * @param appContent
 * @param legacyRender
 */
function getRender(appInstanceId: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    // 遗留渲染,注册微应用时的渲染函数
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.error(
          '[qiankun] Custom rendering function is deprecated and will be removed in 3.0, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }
    // 获取dom对象 container：字符串或者dom对象
    const containerElement = getContainer(container!);

    // The container might have be removed after micro app unmounted.
    // 微应用卸载之后，容器可能会被移除
    // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
    // 例如微应用卸载生命周期被react组件将要卸载生命周期调用，微应用卸载后，react组件也会被移除
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appInstanceId} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appInstanceId} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appInstanceId} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    // 微应用指定的容器(dom && 其中不包括给微应用创建的特定的容器（dom
    if (containerElement && !containerElement.contains(element)) {
      // clear the container
      // 清理容器
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // append the element to container if it exist
      // 将微应用的特定容器id
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  // 验证子应用导出的生命周期是否正确
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // fallback to sandbox latest set property if it had
  // 如果有的话，回退到沙盒最新的设置属性
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  // 模块导出没找到时，回退到使用子应用名称命名的全局变量
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

/**
 * 加载微应用
 * @param app  
 * @param configuration 
 * @param lifeCycles 
 * @returns 
 */
export async function loadApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  // 获取app信息
  const { entry, name: appName } = app;
  // 生成app实例Id
  const appInstanceId = genAppInstanceIdByName(appName);
  // 性能测量的标记名称
  const markName = `[qiankun] App ${appInstanceId} Loading`;
  // 性能测试
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  // 获取框架的配置
  const {
    singular = false,
    sandbox = true,
    excludeAssetFilter,
    globalContext = window,
    ...importEntryOpts
  } = configuration;

  // get the entry html content and script executor
  // 获取入口html内容和脚本执行器
  const { template, execScripts, assetPublicPath } = await importEntry(entry, importEntryOpts);

  // as single-spa load and bootstrap new app parallel with other apps unmounting
  // 因为single-spa加载和启动新微应用与其他微应用并行
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  // we need wait to load the app until all apps are finishing unmount in singular mode
  // 我们需要等待加载微应用直到在单例模式下所有微应用完成卸载，单例架构模式下，需要等待上一个微应用卸载完成后在继续安装当前
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }
  // 获取微应用的入口html
  const appContent = getDefaultTplWrapper(appInstanceId)(template);
  // 是否严格样式隔离
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;

  // 开发环境 && 样式隔离3.0将会被移除
  if (process.env.NODE_ENV === 'development' && strictStyleIsolation) {
    console.warn(
      "[qiankun] strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!",
    );
  }
  // 是否启动作用域css
  const scopedCSS = isEnableScopedCSS(sandbox);
  // 微应用的index.html的安装容器
  let initialAppWrapperElement: HTMLElement | null = createElement(
    appContent,
    strictStyleIsolation,
    scopedCSS,
    appInstanceId,
  );
  // 微应用安装的html id
  const initialContainer = 'container' in app ? app.container : undefined;
  // 微应用是否存在render
  const legacyRender = 'render' in app ? app.render : undefined;
  // 获取微应用的渲染
  const render = getRender(appInstanceId, appContent, legacyRender);

  // 第一次加载设置应用可见区域 dom 结构
  // 确保每次应用加载前容器 dom 结构已经设置完毕
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');
  // 获取微应用包裹dom对象访问器
  const initialAppWrapperGetter = getAppWrapperGetter(
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );

  let global = globalContext;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  const speedySandbox = typeof sandbox === 'object' && !!sandbox.speedy;
  let sandboxContainer;
  if (sandbox) {
    // 创建沙盒容器
    sandboxContainer = createSandboxContainer(
      appInstanceId,
      // FIXME should use a strict sandbox logic while remount, see https://github.com/umijs/qiankun/issues/518
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
      global,
      speedySandbox,
    );
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    // 沙盒的安装和卸载
    mountSandbox = sandboxContainer.mount;
    unmountSandbox = sandboxContainer.unmount;
  }

  // 合并微应用的生命周期函数
  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

  // 触发加载之前函数
  await execHooksChain(toArray(beforeLoad), app, global);

  // get the lifecycle hooks from module exports
  // 从模块导出中获取生命周期钩子，这里是从微应用的入口js文件中获取导出
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox, {
    scopedGlobalVariables: speedySandbox ? lexicalGlobals : [],
  });
  // 从脚本导出获取生命周期
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );

  // 给微应用暴漏的观察者接口
  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> =
    getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  // 整合微应用的启动，安装，更新，卸载生命周期函数
  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        // 开发环境标记性能
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },

        // 验证是横向拆分，还是竖向拆分
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },

        // 这块是为了获取微应用要安装到对应的哪个dom下，如果修改了dom容器，就重新创建
        // initial wrapper element before app mount/remount
        // 微应用安装/重新安装前，初始包裹元素
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(
            appInstanceId,
            !!legacyRender,
            strictStyleIsolation,
            scopedCSS,
            () => appWrapperElement,
          );
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // element will be destroyed after unmounted, we need to recreate it if it not exist
            // 卸载后，元素会被销毁，如果它不存在我们需要重新创建它，或者我们尝试重新安装到一个新容器中
            // or we try to remount into a new container
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },

        // 安装沙盒，为了让微应用执行不会污染全局状态
        mountSandbox,

        // 这里执行了安装之前的生命周期函数，说明马上要开始安装微应用了
        // exec the chain after rendering to keep the behavior with beforeLoad
        // 渲染中执行链式调用来保持加载前的行为
        async () => execHooksChain(toArray(beforeMount), app, global),


        // 安装微应用，这里调用的是微应用中导出来的mount方法，真是的微应用安装
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),

        // 
        // finish loading after app mounted
        // 微应用安装后，结束loading
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        
        // 执行安装完成微应用生命周期函数
        async () => execHooksChain(toArray(afterMount), app, global),

        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        // 在应用程序安装后初始化unmount延迟，并在它卸载后解决延迟
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        // 微应用整个安装过程性能分析
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        // 卸载之前的钩子
        async () => execHooksChain(toArray(beforeUnmount), app, global),

        // 卸载微应用
        async (props) => unmount({ ...props, container: appWrapperGetter() }),

        // 卸载沙盒
        unmountSandbox,

        // 卸载后
        async () => execHooksChain(toArray(afterUnmount), app, global),
        
        async () => {
          // 卸载dom容器
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          // 解绑全局状态监听，释放内存
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },

        // 标记微应用卸载已完成
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
