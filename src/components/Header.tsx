export type SaveStatus = "" | "未保存" | "已保存到本地缓存" | "演示数据已加载" | "本地保存失败" | "本地读取失败" | "本地缓存格式过旧，请重新录入或载入演示数据。" | "本地数据版本不兼容";

export type AppPage = "fit" | "estimate" | "standards";

export default function Header({ activePage, onNavigate }: {
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
}): JSX.Element {
  return (
    <nav className="app-navigation" aria-label="主导航">
      <button type="button" aria-current={activePage === "fit" ? "page" : undefined} onClick={() => onNavigate("fit")}>1. 预估曲线拟合</button>
      <button type="button" aria-current={activePage === "standards" ? "page" : undefined} onClick={() => onNavigate("standards")}>2. 考核标准制定</button>
      <button type="button" aria-current={activePage === "estimate" ? "page" : undefined} onClick={() => onNavigate("estimate")}>3. ROI预估与判断</button>
    </nav>
  );
}
