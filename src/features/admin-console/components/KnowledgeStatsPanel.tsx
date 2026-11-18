"use client";



import type { ReactNode } from "react";

import { Button, Card, Select, Space, Typography } from "antd";

import type { TableProps } from "antd";

import { AdminTable } from "./AdminTable";

import { useAdminTablePageSize } from "../context/AdminTablePageSizeContext";

import { adminTableScrollY } from "../lib/adminTableConfig";

import { sortNum, sortStr } from "../lib/adminColumnHelpers";



const { Title, Text } = Typography;



type HotDocRow = { docPath: string; count: number };

type ColdDocRow = { relPath: string };

type PersonRow = { person: string; pageViews: number; askAi: number };



type Props = {

  busy: boolean;

  days: number;

  migrationDocCount: number;

  hotDocs: HotDocRow[];

  coldDocs: ColdDocRow[];

  personStats: PersonRow[];

  onDaysChange: (days: number) => void;

  onRefresh: () => void;

};



function StatsCard(props: { title: string; minHeight: number; children: ReactNode }) {

  return (

    <Card

      className="admin-card"

      title={props.title}

      style={{ height: "100%", display: "flex", flexDirection: "column" }}

      styles={{ body: { flex: 1, minHeight: props.minHeight, display: "flex", flexDirection: "column" } }}

    >

      {props.children}

    </Card>

  );

}



export function KnowledgeStatsPanel(props: Props) {

  const { pageSize } = useAdminTablePageSize();

  const scrollY = adminTableScrollY(pageSize);

  const cardMinHeight = scrollY + 88;

  const tableScroll = { y: scrollY };



  const hotColumns: TableProps<HotDocRow>["columns"] = [

    { ...sortStr<HotDocRow>("docPath", "文档路径"), ellipsis: true },

    { ...sortNum<HotDocRow>("count", "浏览次数"), width: 120 },

  ];

  const coldColumns: TableProps<ColdDocRow>["columns"] = [

    { ...sortStr<ColdDocRow>("relPath", "文档相对路径"), ellipsis: true },

  ];

  const personColumns: TableProps<PersonRow>["columns"] = [

    { ...sortStr<PersonRow>("person", "人员"), width: 160 },

    { ...sortNum<PersonRow>("pageViews", "浏览"), width: 100 },

    { ...sortNum<PersonRow>("askAi", "文档跳转问AI"), width: 130 },

  ];



  return (

    <Space direction="vertical" style={{ width: "100%" }} size={12}>

      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>

        <Title level={2} style={{ margin: 0 }}>

          迁移文档看板

        </Title>

        <Space wrap>

          <Text type="secondary">迁移文档总数：{props.migrationDocCount}</Text>

          <Select

            style={{ width: 140 }}

            value={props.days}

            onChange={props.onDaysChange}

            options={[

              { value: 7, label: "近 7 天" },

              { value: 30, label: "近 30 天" },

            ]}

          />

          <Button loading={props.busy} onClick={props.onRefresh}>

            刷新

          </Button>

        </Space>

      </Space>



      <div

        style={{

          display: "grid",

          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",

          gap: 12,

          width: "100%",

        }}

      >

        <StatsCard title="热门文档" minHeight={cardMinHeight}>

          <AdminTable<HotDocRow>
            tableKey="knowledge-hot-docs"
            rowKey={(row, index) => `${row.docPath}::${index}`}

            size="small"
            scroll={tableScroll}
            columns={hotColumns}

            dataSource={props.hotDocs}

          />

        </StatsCard>

        <StatsCard title="人员阅读榜" minHeight={cardMinHeight}>

          <AdminTable<PersonRow>
            tableKey="knowledge-person-stats"
            rowKey="person"

            size="small"
            scroll={tableScroll}
            columns={personColumns}

            dataSource={props.personStats}

          />

        </StatsCard>

      </div>



      <Card className="admin-card" title="冷门文档（近 30 天无浏览）">

        <AdminTable<ColdDocRow> tableKey="knowledge-cold-docs" rowKey="relPath" size="small" columns={coldColumns} dataSource={props.coldDocs} />

      </Card>

    </Space>

  );

}


