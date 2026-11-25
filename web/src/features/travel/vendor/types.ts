/**
 * 高德 JSAPI 2.0 的务实类型声明：只覆盖本模块用到的面，允许 any 级别的宽松签名，
 * 不追求完整 SDK 类型。公开函数签名保持具体。
 */

/** loadAmap / ensurePlugins 失败时 reject 的错误形态 */
export type LoadError = {
  code: "missing_key" | "dynamic_import_failed" | "timeout" | "plugin_failed";
  message: string;
};

export interface AMapNamespace {
  /** 地图构造器 */
  Map: any;
  /** 经纬度构造器，GCJ-02，[lng, lat] */
  LngLat: any;
  /** 标记构造器 */
  Marker: any;
  /** 折线构造器 */
  Polyline: any;

  /**
   * 异步加载插件，缺失插件数组 + 回调，包装为 promise 见 amapLoader.ensurePlugins。
   * 签名形如 plugin(names: string[], callback: () => void)：加载成功或全部已存在时回调。
   */
  plugin: (names: string[], callback: () => void) => void;

  /* 以下为按需插件对应的构造器：插件加载完成后才可用，签名保持宽松 */
  /** 定位插件 AMap.Geolocation */
  Geolocation?: any;
  /** POI 搜索插件 AMap.PlaceSearch */
  PlaceSearch?: any;
  /** 输入提示插件 AMap.AutoComplete */
  AutoComplete?: any;
  /** 步行路线规划插件 AMap.Walking */
  Walking?: any;
  /** 公交/地铁路线规划插件 AMap.Transfer */
  Transfer?: any;
  /** 城市查询插件（公交规划需要城市） */
  CitySearch?: any;
}

declare global {
  interface Window {
    /**
     * 高德安全密钥注入点（securityJsCode），必须在 loader 加载前写入。
     * 注意：该值与 key 同为敏感信息，不得打印到日志。
     */
    _AMapSecurityConfig?: { securityJsCode: string };
    /** JSAPI loader 注入的全局命名空间 */
    AMap?: AMapNamespace;
  }
}
