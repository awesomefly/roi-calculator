import { useId, useState } from "react";
import type { ModelResult } from "../domain/types";

interface PrincipleCopy {
  principle: string;
  suitableFor: string;
  limitation: string;
}

const PRINCIPLES: Record<ModelResult["id"], PrincipleCopy> = {
  historical_multiplier: {
    principle: "使用包含真实 D360 的成熟观测，计算各观测日到 D360 的增长倍率，再按真实观测点插值或校准预测曲线。",
    suitableFor: "有真实 D360 历史数据，且业务增长节奏相对稳定的场景。",
    limitation: "没有真实 D360 时不可用；历史阶段倍率发生结构性变化时，预测偏差会增大。",
  },
  logarithmic: {
    principle: "以首个真实观测点为锚点，用 ROI(day) = ROI(firstDay) + slope × ln(day / firstDay) 拟合后续增长。",
    suitableFor: "前期增长较快、后期边际增长逐渐放缓，但未显示固定上限的累计 ROI。",
    limitation: "长期仍会继续增长，不会自然收敛到固定上限；观测点较少时外推不确定性较高。",
  },
  power: {
    principle: "用 ROI(day) = coefficient × day^exponent 拟合累计 ROI，指数决定曲线增长速度如何随时间变化。",
    suitableFor: "持续增长且增长速率按比例逐渐变化的累计 ROI 曲线。",
    limitation: "所有观测 ROI 必须大于 0；模型没有固定收敛上限，长距离外推可能偏高或偏低。",
  },
  saturation: {
    principle: "用 ROI(day) = ceiling × (1 - e^(-rate × day)) + offset 拟合，让累计 ROI 随时间逐步接近上限。",
    suitableFor: "收入释放逐渐衰减，长期 ROI 趋于稳定上限的业务。",
    limitation: "至少需要三个有效观测点；早期数据还未显示饱和趋势时，上限和速率参数可能不稳定。",
  },
  retention_multiplier: { principle: "用历史 Dn 到 D360 倍率回归时间与对应留存率。", suitableFor: "有真实 D360 和逐点留存的成熟批次。", limitation: "统计关联不代表因果关系。" },
  retention_logarithmic: { principle: "在对数时间曲线中加入留存及交互项。", suitableFor: "长期边际增长放缓的数据。", limitation: "统计关联不代表因果关系。" },
  retention_power: { principle: "在幂函数曲线中加入留存及交互项。", suitableFor: "按比例变化的持续增长曲线。", limitation: "统计关联不代表因果关系。" },
  retention_saturation: { principle: "用留存共同修正长期上限与收敛速度。", suitableFor: "长期趋于稳定上限的数据。", limitation: "统计关联不代表因果关系。" },
  retention_monotone_spline: { principle: "用受单调约束的低自由度样条联合时间与留存。", suitableFor: "大样本且参数模型形状不足的数据。", limitation: "满足自动准入条件后参与多模型等权综合曲线。" },
};

export default function ModelPrinciple({ modelId, label }: {
  modelId: ModelResult["id"];
  label: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const copy = PRINCIPLES[modelId];

  return <>
    <div className="model-help__heading">
      <h3>{label}</h3>
      <button
        type="button"
        className="model-help__trigger"
        aria-label={`查看${label}原理`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >?</button>
    </div>
    {open && <div id={panelId} className="model-help__panel" role="region" aria-label={`${label}原理说明`}>
      <p><strong>原理：</strong>{copy.principle}</p>
      <p><strong>适用：</strong>{copy.suitableFor}</p>
      <p><strong>限制：</strong>{copy.limitation}</p>
    </div>}
  </>;
}
