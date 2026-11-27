import {attackSkills, builderCatalog, equipmentCatalog, monsterSkills, previewCharacter, scenarioCatalog, simulate, targets, testMonsterSkill} from "../RO-idle-dps/engine.js?v=20261127-21";

self.onmessage = ({data: {id, action, snapshot, options}}) => {
  try {
    const result = {
      targets: () => targets,
      builder: () => builderCatalog(),
      mobSkills: () => monsterSkills(options.monsterId),
      testMobSkill: () => testMonsterSkill(snapshot, options),
      skills: () => attackSkills(snapshot),
      scenario: () => scenarioCatalog(snapshot),
      equipment: () => equipmentCatalog(snapshot),
      character: () => previewCharacter(snapshot, options.scenario, options.mode, options.monsterId),
      simulate: () => simulate(snapshot, options),
    }[action]();
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
