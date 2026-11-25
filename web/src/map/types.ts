/** 高德 JS API 2.0 的最小类型子集（仅覆盖本项目用到的接口，避免引入完整类型包） */

export interface AmapMapInstance {
  destroy(): void;
  add(overlay: unknown): void;
  remove(overlay: unknown): void;
  setFitView(overlays?: unknown[] | null, immediately?: boolean, avoid?: number[], maxZoom?: number): void;
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  /** 当前中心点所在城市（2.0 保留该方法；用于把 AutoComplete 限定到“我所在的城市”） */
  getCity?(cb: (result: { city?: string; adcode?: string; citycode?: string }) => void): void;
}

export interface AmapOverlayInstance {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
  setLabel?(opts: { content: string; direction?: string }): void;
  setText?(text: string): void;
  setExtData?(ext: unknown): void;
  show?(): void;
  hide?(): void;
}

export interface AmapInfoWindowInstance {
  open(map: AmapMapInstance, position: [number, number]): void;
  close(): void;
  setContent(content: string): void;
}

export interface AmapNamespace {
  Map: new (container: HTMLElement | string, opts: Record<string, unknown>) => AmapMapInstance;
  Marker: new (opts: Record<string, unknown>) => AmapOverlayInstance;
  Polyline: new (opts: Record<string, unknown>) => AmapOverlayInstance;
  Text: new (opts: Record<string, unknown>) => AmapOverlayInstance;
  InfoWindow: new (opts: Record<string, unknown>) => AmapInfoWindowInstance;
  Pixel: new (x: number, y: number) => unknown;
  /** 经纬度构造器（高德 JSAPI 2.0，GCJ-02） */
  LngLat?: new (lng: number, lat: number) => unknown;
  /** 插件懒加载：AMap.plugin(["AMap.Geolocation", ...], cb) 后对应构造器挂到命名空间上 */
  plugin?: (names: string[], cb: () => void) => void;
  Geolocation?: new (opts: Record<string, unknown>) => AmapGeolocationPlugin;
  PlaceSearch?: new (opts: Record<string, unknown>) => AmapPlaceSearchPlugin;
  CitySearch?: new (opts?: Record<string, unknown>) => AmapCitySearchPlugin;
  /** 注意类名是 AutoComplete（大写 C），写成 Autocomplete 会拿到 undefined */
  AutoComplete?: new (opts?: Record<string, unknown>) => AmapAutoCompletePlugin;
  /** 步行路线规划插件（插件加载完成后才可用） */
  Walking?: new (opts?: Record<string, unknown>) => AmapWalkingPlugin;
}

/** AMap.Walking 插件（只声明本项目用到的 search） */
export interface AmapWalkingPlugin {
  search(
    origin: unknown,
    destination: unknown,
    cb: (status: unknown, result: unknown) => void
  ): void;
}

/** AMap.AutoComplete 输入提示：能检索到 PlaceSearch 搜不出的低权重 POI（如高校校门） */
export interface AmapAutoCompleteTip {
  name?: string;
  location?: { lng: number; lat: number };
  district?: string;
  address?: string;
  id?: string;
}

export interface AmapAutoCompletePlugin {
  search(
    keyword: string,
    cb: (status: string, result: { tips?: AmapAutoCompleteTip[]; info?: string }) => void
  ): void;
}

/** AMap.Geolocation 插件回调结果（最小子集） */
export interface AmapGeolocationResult {
  info?: string;
  message?: string;
  position?: { lng: number; lat: number };
  /** 定位精度（米） */
  accuracy?: number;
}

export interface AmapGeolocationPlugin {
  getCurrentPosition(cb: (status: string, result: AmapGeolocationResult) => void): void;
}

/** AMap.CitySearch 插件回调结果：IP 定位到城市（浏览器精确定位不可用时的兜底） */
export interface AmapCitySearchResult {
  info?: string;
  city?: string;
  province?: string;
  citycode?: string;
  /** 城市边界：数组 [[西南经度, 西南纬度], [东北经度, 东北纬度]] 或字符串 "lng1,lat1;lng2,lat2"（高德实际返回字符串） */
  bounds?: number[][] | string;
}

export interface AmapCitySearchPlugin {
  getLocalCity(cb: (status: string, result: AmapCitySearchResult) => void): void;
}

export interface AmapPlaceSearchPoi {
  name?: string;
  location?: { lng: number; lat: number };
  distance?: string | number;
  address?: string;
  /** POI 所在城市（SDK 实际返回；用于把 AutoComplete 限定到我所在的城市） */
  cityname?: string;
}

export interface AmapPlaceSearchResult {
  info?: string;
  poiList?: { pois?: AmapPlaceSearchPoi[] };
}

export interface AmapPlaceSearchPlugin {
  search(
    keyword: string,
    cb: (status: string, result: AmapPlaceSearchResult) => void
  ): void;
  /** 周边搜索（用于获取场馆各门、接驳站点）；部分 SDK 版本才提供 */
  searchNearBy?(
    keyword: string,
    center: [number, number],
    radius: number,
    cb: (status: string, result: AmapPlaceSearchResult) => void
  ): void;
}
