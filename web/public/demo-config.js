/**
 * 运行时配置模板（demo 交付包使用）。
 *
 * 部署后可直接编辑本文件，刷新页面生效，无需重新构建前端。
 * 留空表示回退到构建期环境变量或内置默认值；请勿把真实密钥提交到公开仓库。
 *
 * - amapKey / amapSecurityJsCode：高德「Web端（JS API）」Key 与配套安全密钥。
 *   不配置时地图模式不可用，但「示意图」模式、路线规划、回放等功能不受影响。
 * - mapGeoJson：场地坐标映射（JSON 字符串，非凭据）。
 * - apiBaseUrl：后端 API 地址；空字符串表示与页面同源（推荐，配合内置网关使用）。
 */
window.__DEMO_CONFIG__ = {
  amapKey: "",
  amapSecurityJsCode: "",
  mapGeoJson: "",
  // apiBaseUrl: "",
};
