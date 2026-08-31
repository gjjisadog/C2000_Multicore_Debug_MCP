import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import {
  candidateSkillInputSchema,
  candidateSkillSchema,
  evolutionRunSchema,
  experienceSchema,
  lessonSchema,
  skillEditPolicySchema,
  type CandidateSkill,
  type EvolutionRun,
  type Experience,
  type Lesson,
  type SkillEditPolicy
} from "./EvolutionSchemas.js";
import { RejectedEditBuffer } from "./RejectedEditBuffer.js";
import { evaluatePromotion, promotionGateInputSchema, type PromotionGateResult } from "./SkillPromotionGate.js";
import { validateSkillEdits } from "./SkillEditPolicy.js";

export class EvolutionService {
  readonly rejectedEdits: RejectedEditBuffer;
  private readonly writer: AtomicArtifactWriter;
  private readonly rootDirectory: string;

  constructor(options: { rootDirectory: string; writer?: AtomicArtifactWriter }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.rejectedEdits = new RejectedEditBuffer({ rootDirectory: this.rootDirectory, writer: this.writer });
  }

  async createCandidate(rawInput: unknown): Promise<CandidateSkill> {
    const input = candidateSkillInputSchema.parse(rawInput);
    const policy: SkillEditPolicy = skillEditPolicySchema.parse(input.policy);
    const validation = validateSkillEdits(input.edits, policy);
    if (!validation.valid) throw new Error(`Candidate skill rejected by bounded edit policy: ${validation.errors.join("; ")}`);
    const candidate = candidateSkillSchema.parse({
      ...input,
      schemaVersion: 1,
      candidateSkillId: input.candidateSkillId ?? `candidate-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      promoted: false,
      edits: validation.edits,
      policy
    });
    await this.writer.writeJson(path.join(this.rootDirectory, "candidates", `${safeId(candidate.candidateSkillId)}.json`), candidate);
    return candidate;
  }

  async recordEvolutionRun(rawInput: unknown): Promise<EvolutionRun> {
    const run = evolutionRunSchema.parse(rawInput);
    await this.writer.writeJson(path.join(this.rootDirectory, "runs", `${safeId(run.evolutionRunId)}.json`), run);
    if (run.decision === "REJECTED") {
      const reason = run.rejectedReason ?? "Promotion gate rejected candidate";
      for (const edit of run.candidateEdits) {
        await this.rejectedEdits.append({
          skillName: run.skillName,
          baseSkillVersion: run.baseSkillVersion,
          ...(run.candidateSkillVersion ? { candidateSkillVersion: run.candidateSkillVersion } : {}),
          edit,
          reason,
          baselineScore: run.baselineScore,
          candidateScore: run.candidateScore,
          validationVerificationIds: run.validationVerificationIds,
          hardGateFailures: run.hardGateFailures
        });
      }
    }
    return run;
  }

  async recordExperience(rawInput: unknown): Promise<Experience> {
    const experience = experienceSchema.parse(rawInput);
    await this.writer.writeJson(path.join(this.rootDirectory, "experiences", `${safeId(experience.experienceId)}.json`), experience);
    return experience;
  }

  async recordLesson(rawInput: unknown): Promise<Lesson> {
    const lesson = lessonSchema.parse(rawInput);
    await this.writer.writeJson(path.join(this.rootDirectory, "lessons", `${safeId(lesson.lessonId)}.json`), lesson);
    return lesson;
  }

  evaluatePromotion(rawInput: unknown): PromotionGateResult {
    return evaluatePromotion(promotionGateInputSchema.parse(rawInput));
  }

  async getEvolutionRun(evolutionRunId: string): Promise<EvolutionRun> {
    const value = JSON.parse(await readFile(path.join(this.rootDirectory, "runs", `${safeId(evolutionRunId)}.json`), "utf8"));
    return evolutionRunSchema.parse(value);
  }

  async getExperience(experienceId: string): Promise<Experience> {
    const value = JSON.parse(await readFile(path.join(this.rootDirectory, "experiences", `${safeId(experienceId)}.json`), "utf8"));
    return experienceSchema.parse(value);
  }

  async getLesson(lessonId: string): Promise<Lesson> {
    const value = JSON.parse(await readFile(path.join(this.rootDirectory, "lessons", `${safeId(lessonId)}.json`), "utf8"));
    return lessonSchema.parse(value);
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe evolution id: ${value}`);
  return value;
}
