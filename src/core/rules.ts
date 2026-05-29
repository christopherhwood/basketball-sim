export type RulesConfig = {
  offensiveThreeSeconds: boolean;
  defensiveThreeSeconds: boolean;
  threeSecondLimit: number;
  defensiveThreeSecondsGuardingDistance: number;
};

export const rules: RulesConfig = {
  offensiveThreeSeconds: true,
  defensiveThreeSeconds: true,
  threeSecondLimit: 3,
  defensiveThreeSecondsGuardingDistance: 6,
};
