"use client";

import { useMemo } from "react";
import { Button, Collapse, Tag } from "antd";
import { DataTable } from "@/shared/data-table/DataTable";
import { assessPackageGrowth } from "@/lib/package-comparison/assessment";
import { REPORT_SIZE_UNIT, sizeText } from "@/lib/package-comparison/types";
import type {
  Explanation,
  PackageFile,
  PackageResult,
} from "@/lib/package-comparison/types";
import styles from "./PackageComparison.module.css";

export function GrowthAssessment({
  result,
  notes,
  onEdit,
  editable,
}: {
  result: PackageResult;
  notes: Explanation;
  onEdit: (file: PackageFile) => void;
  editable: boolean;
}) {
  const assessment = useMemo(
    () => assessPackageGrowth(result, notes),
    [result, notes],
  );
  return (
    <section className={styles.assessment} aria-label="增量合理性评估">
      <div className={styles.assessmentHeading}>
        <h4>增量合理性评估</h4>
        <Tag color={assessment.risks.length ? "warning" : "default"}>
          {assessment.risks.length
            ? `${assessment.risks.length} 项待核查`
            : "待人工确认"}
        </Tag>
        <span className={styles.muted}>辅助评估，不自动改变审核结论</span>
      </div>
      <p className={styles.assessmentConclusion}>{assessment.title}</p>
      <p className={styles.muted}>
        整包净增 {sizeText(result.delta, REPORT_SIZE_UNIT, 3)}
        {" · "}增量预算{" "}
        {result.rules.budgetBytes === null
          ? "未设置"
          : sizeText(result.rules.budgetBytes, REPORT_SIZE_UNIT, 3)}
        {" · "}单图提醒值{" "}
        {assessment.imageLimit === null
          ? "已关闭"
          : sizeText(assessment.imageLimit, REPORT_SIZE_UNIT)}
        {assessment.usesSuggestedImageLimit && "（参考值，历史任务未配置）"}
      </p>
      {assessment.risks.length > 0 && (
        <DataTable
          tableKey="package-growth-risks"
          size="small"
          rowKey="id"
          dataSource={assessment.risks}
          pagination={{
            pageSize: 3,
            showSizeChanger: false,
            hideOnSinglePage: true,
            showTotal: (n) => `共 ${n} 项`,
          }}
          columns={[
            {
              title: "风险与依据",
              width: 360,
              sorter: (left, right) => left.title.localeCompare(right.title, "zh"),
              filters: [...new Set(assessment.risks.map((risk) => risk.title))].map((title) => ({ text: title, value: title })),
              onFilter: (value, risk) => risk.title === value,
              render: (_, risk) => (
                <>
                  <strong>{risk.title}</strong>
                  <div>{risk.evidence}</div>
                  {risk.files.slice(0, 2).map((file) => (
                    <div className={styles.path} key={file.key}>
                      {file.path}
                    </div>
                  ))}
                  {risk.files.length > 2 && (
                    <Collapse
                      ghost
                      size="small"
                      items={[
                        {
                          key: "paths",
                          label: `其余 ${risk.files.length - 2} 个文件`,
                          children: risk.files.slice(2).map((file) => (
                            <div className={styles.path} key={file.key}>
                              {file.path}
                            </div>
                          )),
                        },
                      ]}
                    />
                  )}
                </>
              ),
            },
            {
              title: "建议核查",
              sorter: (left, right) => left.suggestion.localeCompare(right.suggestion, "zh"),
              render: (_, risk) => (
                <>
                  <div>{risk.suggestion}</div>
                  {risk.files.length === 1 && editable && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => onEdit(risk.files[0])}
                    >
                      填写文件说明
                    </Button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {assessment.context.length > 0 && (
        <ul className={styles.assessmentContext}>
          {assessment.context.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {assessment.existingLargeImages > 0 && (
        <p className={styles.muted}>
          另有 {assessment.existingLargeImages}{" "}
          张未新增或增大的存量图片超过提醒值，未计入本次增量风险。
        </p>
      )}
      <Collapse
        ghost
        size="small"
        items={[
          {
            key: "criteria",
            label: "评估口径",
            children: (
              <p className={styles.muted}>
                {assessment.metric}{" "}
                单图提醒值可在新建对比的项目规则中调整或留空关闭。评估版本：
                {assessment.version}。
              </p>
            ),
          },
        ]}
      />
    </section>
  );
}
